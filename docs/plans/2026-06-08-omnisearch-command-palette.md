# Omnisearch / Command Palette Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the dead topbar search box into a VSCode-style omnisearch + command palette that fuzzy-finds across Journal, Pages, Projects, Sessions, and Files, and runs actions via a `>` prefix.

**Architecture:** A pure, dependency-injected `commandPalette.ts` controller renders a dropdown under the topbar input and handles keyboard + mode switching. It knows nothing about orden's stores — `main.ts` constructs five `SearchSource` objects (closing over the already-hydrated store getters and existing openers) plus a `Command` registry and passes them in. A standalone `fuzzy.ts` scorer ranks within each group. No host round-trips: every source reads in-memory state.

**Tech Stack:** TypeScript, vanilla DOM, vitest + happy-dom (existing `apps/web/test` patterns). No new dependencies (cooldown-safe).

**Design doc:** `docs/plans/2026-06-08-omnisearch-command-palette-design.md`

---

## Reference: what already exists

In-memory store getters (all synchronous, hydrated at boot):

- `pageNames(): string[]`, `getPageMarkdown(name): string`, `pagesIndex(): PageInfo[]` — `apps/web/src/pages.ts`. Journal days are pages whose name matches `/^\d{4}-\d{2}-\d{2}$/`; real pages are the rest (minus `card:`/`notes:`, already excluded by `pagesIndex()`).
- `listProjects(): Project[]` — `apps/web/src/projects.ts` (`{id, name, source}`; `source.path` for local).
- `listSessions(includeArchived?): Session[]` — `apps/web/src/sessions.ts` (`{id, title, projectId}`).
- `listItems(): Item[]` — `apps/web/src/cards.ts` (`{id, title, state, sessionIds...}`); a card is a session's projection, carries the lifecycle `state`.
- `listFiles(): RepoFile[]` — `apps/web/src/files.ts` (`{path, title, content}`, repo md docs).

Existing openers in `main.ts` (reuse — do NOT add routing):

- `openPage(name)` (1159), `openProject(projectId)` (1223), `openRepoFile(projectId, path)` (1446, async; repo files use projectId `"repo"`), `openSessionInPanel(id)` (1082), `journal.showPage(name)` / `journal.showJournal()`, `viewStore.set(view)`.

Dead seam to replace: `onSearch()` + the Cmd+K/Enter/Esc wiring at `apps/web/src/main.ts:1666-1697`.

---

## Task 1: Fuzzy matcher

**Files:**
- Create: `apps/web/src/fuzzy.ts`
- Test: `apps/web/test/fuzzy.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { fuzzyScore, fuzzyRank } from "../src/fuzzy";

describe("fuzzyScore", () => {
  it("returns null when chars are not a subsequence", () => {
    expect(fuzzyScore("xyz", "hello")).toBeNull();
  });
  it("matches a subsequence case-insensitively", () => {
    expect(fuzzyScore("hlo", "Hello")).not.toBeNull();
  });
  it("scores contiguous + prefix matches higher than scattered", () => {
    const prefix = fuzzyScore("hel", "hello world")!;
    const scattered = fuzzyScore("hel", "h e l p f u l")!;
    expect(prefix).toBeGreaterThan(scattered);
  });
  it("empty query scores 0 (matches everything)", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("fuzzyRank", () => {
  it("drops non-matches and sorts by score desc", () => {
    const items = [{ t: "apple" }, { t: "kiwi" }, { t: "maple" }];
    const ranked = fuzzyRank("ap", items, (i) => i.t);
    expect(ranked.map((r) => r.item.t)).toEqual(["apple", "maple"]);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @orden/web exec vitest run test/fuzzy.test.ts`
Expected: FAIL — cannot find module `../src/fuzzy`.

**Step 3: Implement**

```typescript
// apps/web/src/fuzzy.ts
// A small subsequence fuzzy scorer. Higher score = better. null = no match.
// Heuristic: each matched char scores 1; consecutive matches and matches at a
// word boundary / string start get a bonus, so contiguous and prefix hits rank
// above scattered ones. Case-insensitive.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 2; // contiguous run
    if (found === 0 || /\s|[/_-]/.test(t[found - 1])) score += 2; // boundary
    prevMatch = found;
    ti = found + 1;
  }
  return score;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keyFn: (item: T) => string,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, keyFn(item));
    if (score !== null) out.push({ item, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
```

**Step 4: Run to verify it passes**

Run: `pnpm --filter @orden/web exec vitest run test/fuzzy.test.ts`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add apps/web/src/fuzzy.ts apps/web/test/fuzzy.test.ts
git commit -m "feat: fuzzy subsequence scorer for command palette"
```

---

## Task 2: Command palette controller — types + query routing

**Files:**
- Create: `apps/web/src/commandPalette.ts`
- Test: `apps/web/test/commandPalette.test.ts`

The controller is pure: it's handed `sources` and `commands`, an `input` and a `form`, and a `mount` element for the dropdown. This task covers the data layer (query → grouped results, `>` → commands, per-group cap). Rendering DOM is verified here too since it's cheap in happy-dom.

**Step 1: Write the failing test**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandPalette } from "../src/commandPalette";
import type { SearchSource, Command } from "../src/commandPalette";

afterEach(() => document.body.replaceChildren());

function harness(sources: SearchSource[], commands: Command[] = []) {
  const form = document.createElement("form");
  const input = document.createElement("input");
  const mount = document.createElement("div");
  form.append(input);
  document.body.append(form, mount);
  const palette = createCommandPalette({ form, input, mount, sources, commands });
  return { form, input, mount, palette };
}

const src = (id: string, items: string[]): SearchSource => ({
  id,
  label: id,
  search: (q) =>
    items
      .filter((t) => t.includes(q))
      .map((t) => ({ id: `${id}:${t}`, title: t, open: vi.fn() })),
});

describe("command palette query routing", () => {
  it("groups results by source in registration order, capped at 4", () => {
    const { input, mount, palette } = harness([
      src("Journal", ["ja", "jb"]),
      src("Files", ["fa", "fb", "fc", "fd", "fe"]),
    ]);
    input.value = "";
    palette.update();
    const groups = [...mount.querySelectorAll(".palette-group")];
    expect(groups.map((g) => g.getAttribute("data-source"))).toEqual([
      "Journal",
      "Files",
    ]);
    const fileRows = mount.querySelectorAll('[data-source="Files"] .palette-row');
    expect(fileRows).toHaveLength(4); // capped
    expect(mount.querySelector('[data-source="Files"] .palette-more')?.textContent)
      .toContain("1 more");
  });

  it("> switches to command mode and filters commands", () => {
    const run = vi.fn();
    const { input, mount, palette } = harness(
      [src("Files", ["fa"])],
      [{ id: "c1", title: "New session", run }],
    );
    input.value = ">new";
    palette.update();
    expect(mount.querySelector(".palette-group[data-source]")).toBeNull(); // no search groups
    const rows = mount.querySelectorAll(".palette-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("New session");
  });

  it("omits empty groups", () => {
    const { input, mount, palette } = harness([src("Pages", ["zzz"])]);
    input.value = "qqq";
    palette.update();
    expect(mount.querySelector(".palette-group")).toBeNull();
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @orden/web exec vitest run test/commandPalette.test.ts`
Expected: FAIL — cannot find module.

**Step 3: Implement (data + render; keyboard added in Task 3)**

```typescript
// apps/web/src/commandPalette.ts
import { fuzzyRank } from "./fuzzy";

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  open: () => void;
}

export interface SearchSource {
  id: string;
  label: string;
  search: (query: string) => PaletteItem[];
}

export interface Command {
  id: string;
  title: string;
  run: () => void;
}

export interface PaletteDeps {
  form: HTMLFormElement;
  input: HTMLInputElement;
  mount: HTMLElement;
  sources: SearchSource[];
  commands: Command[];
}

const GROUP_CAP = 4;

export interface PaletteController {
  update: () => void;
  open: (prefill?: string) => void;
  close: () => void;
}

export function createCommandPalette(deps: PaletteDeps): PaletteController {
  const { form, input, mount, sources, commands } = deps;
  mount.classList.add("palette");
  let flat: PaletteItem[] = []; // current selectable rows, in visual order
  let active = 0;

  function rankCommands(q: string): PaletteItem[] {
    return fuzzyRank(q, commands, (c) => c.title).map(({ item }) => ({
      id: item.id,
      title: item.title,
      open: item.run,
    }));
  }

  function render(groups: { label: string; items: PaletteItem[]; extra: number }[]): void {
    mount.replaceChildren();
    flat = [];
    if (groups.length === 0) {
      mount.classList.remove("open");
      return;
    }
    for (const g of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "palette-group";
      groupEl.setAttribute("data-source", g.label);
      const head = document.createElement("div");
      head.className = "palette-group-head";
      head.textContent = g.label;
      groupEl.append(head);
      for (const item of g.items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "palette-row";
        row.textContent = item.title;
        if (item.subtitle) {
          const sub = document.createElement("span");
          sub.className = "palette-sub";
          sub.textContent = item.subtitle;
          row.append(sub);
        }
        const idx = flat.length;
        row.addEventListener("click", () => choose(idx));
        flat.push(item);
        groupEl.append(row);
      }
      if (g.extra > 0) {
        const more = document.createElement("div");
        more.className = "palette-more";
        more.textContent = `+${g.extra} more`;
        groupEl.append(more);
      }
      mount.append(groupEl);
    }
    active = 0;
    paintActive();
    mount.classList.add("open");
  }

  function paintActive(): void {
    const rows = [...mount.querySelectorAll<HTMLElement>(".palette-row")];
    rows.forEach((r, i) => r.classList.toggle("active", i === active));
  }

  function choose(idx: number): void {
    const item = flat[idx];
    if (!item) return;
    close();
    item.open();
  }

  function update(): void {
    const raw = input.value;
    if (raw.startsWith(">")) {
      const q = raw.slice(1).trim();
      const items = rankCommands(q);
      render(items.length ? [{ label: "Commands", items, extra: 0 }] : []);
      return;
    }
    const q = raw.trim();
    const groups = sources
      .map((s) => {
        const all = s.search(q);
        return { label: s.label, items: all.slice(0, GROUP_CAP), extra: Math.max(0, all.length - GROUP_CAP) };
      })
      .filter((g) => g.items.length > 0);
    render(groups);
  }

  function open(prefill?: string): void {
    if (prefill !== undefined) input.value = prefill;
    input.focus();
    update();
  }

  function close(): void {
    mount.classList.remove("open");
    mount.replaceChildren();
    flat = [];
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    choose(active);
  });
  input.addEventListener("input", update);

  // keyboard nav wired in Task 3
  return {
    update,
    open,
    close,
    // exposed for Task 3 tests:
    // @ts-expect-error internal handles attached in Task 3
    _nav: undefined,
  } as PaletteController;
}
```

**Step 4: Run to verify it passes**

Run: `pnpm --filter @orden/web exec vitest run test/commandPalette.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add apps/web/src/commandPalette.ts apps/web/test/commandPalette.test.ts
git commit -m "feat: command palette controller — query routing + grouped render"
```

---

## Task 3: Keyboard navigation + selection

**Files:**
- Modify: `apps/web/src/commandPalette.ts`
- Test: `apps/web/test/commandPalette.test.ts` (add a describe block)

**Step 1: Write the failing tests**

```typescript
function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("palette keyboard", () => {
  it("ArrowDown/Up moves the active row and wraps", () => {
    const { input, mount, palette } = harness([src("Files", ["fa", "fb"])]);
    palette.open("f");
    press(input, "ArrowDown");
    expect(mount.querySelectorAll(".palette-row")[1].classList.contains("active")).toBe(true);
    press(input, "ArrowDown"); // wrap to top
    expect(mount.querySelectorAll(".palette-row")[0].classList.contains("active")).toBe(true);
  });

  it("Enter opens the active row and closes", () => {
    const open = vi.fn();
    const sources: SearchSource[] = [
      { id: "Files", label: "Files", search: () => [{ id: "x", title: "x", open }] },
    ];
    const { input, mount, palette } = harness(sources);
    palette.open("");
    press(input, "Enter");
    expect(open).toHaveBeenCalledOnce();
    expect(mount.classList.contains("open")).toBe(false);
  });

  it("Escape clears a non-empty query first, then closes on a second press", () => {
    const { input, mount, palette } = harness([src("Files", ["fa"])]);
    palette.open("fa");
    press(input, "Escape");
    expect(input.value).toBe(""); // first Esc clears, palette stays open
    expect(mount.classList.contains("open")).toBe(true);
    press(input, "Escape");
    expect(mount.classList.contains("open")).toBe(false); // second Esc closes
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @orden/web exec vitest run test/commandPalette.test.ts`
Expected: FAIL — Arrow keys do nothing / Enter handler not on keydown.

**Step 3: Implement — add a keydown handler before the `return`**

```typescript
  input.addEventListener("keydown", (e) => {
    const rows = flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows) { active = (active + 1) % rows; paintActive(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows) { active = (active - 1 + rows) % rows; paintActive(); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Two-stage: first press clears a non-empty query (stays open); second closes.
      if (input.value !== "") { input.value = ""; update(); }
      else { close(); input.blur(); }
    }
  });
```

Replace the placeholder `return { ... } as PaletteController;` with a clean:

```typescript
  return { update, open, close };
```

**Step 4: Run to verify it passes**

Run: `pnpm --filter @orden/web exec vitest run test/commandPalette.test.ts`
Expected: PASS (all 6).

**Step 5: Commit**

```bash
git add apps/web/src/commandPalette.ts apps/web/test/commandPalette.test.ts
git commit -m "feat: command palette keyboard nav + selection"
```

---

## Task 4: Dropdown styling

**Files:**
- Modify: `apps/web/index.html` (the `<head>` style block) or the app stylesheet (match where existing component CSS lives — grep `.omnisearch` first).

No test (visual). Add a positioned dropdown under the topbar input: absolute, anchored to the omnisearch form, app surface bg, subtle border/shadow, `.palette` hidden unless `.open`, `.palette-group-head` small/muted, `.palette-row.active` highlighted, `.palette-sub`/`.palette-more` muted. Reuse existing CSS variables (grep an existing component for the token names — e.g. `--surface`, `--border`, accent).

**Commit**

```bash
git add apps/web/index.html
git commit -m "style: command palette dropdown"
```

---

## Task 5: Wire into main.ts

**Files:**
- Modify: `apps/web/src/main.ts` (replace the `onSearch` seam at 1666-1697; add imports)
- Modify: `apps/web/index.html` if a `mount` element is needed under the form (add `<div id="palette-results"></div>` inside/after `#omnisearch-form`).

**Step 1: Add the mount element** in `index.html` right after the omnisearch input, inside the form so it positions correctly:

```html
<div id="palette-results"></div>
```

**Step 2: Replace the seam.** Delete `onSearch()` and the `if (searchForm && searchInput) { ... }` block (1673-1697). Add at the top of `main.ts` with the other imports:

```typescript
import { createCommandPalette } from "./commandPalette";
import type { SearchSource, Command } from "./commandPalette";
import { listFiles } from "./files";
import { fuzzyRank } from "./fuzzy";
// (pageNames, getPageMarkdown, pagesIndex, listProjects, listSessions, listItems
//  are already imported or import them alongside their siblings.)
```

Build the sources (note: Journal = date-named pages, Pages = the rest). Read fresh from the getters inside `search` so they stay live without re-wiring:

```typescript
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function snippet(md: string, q: string): string | undefined {
  if (!q) return undefined;
  const line = md.split("\n").find((l) => l.toLowerCase().includes(q.toLowerCase()));
  return line?.trim().slice(0, 80);
}

const searchSources: SearchSource[] = [
  {
    id: "journal",
    label: "Journal",
    search: (q) => {
      const days = pageNames().filter((n) => DATE_RE.test(n));
      // match on date OR body text; rank by the date string
      const hits = days.filter(
        (d) => fuzzyScore(q, d) !== null || (q && getPageMarkdown(d).toLowerCase().includes(q.toLowerCase())),
      );
      return hits
        .sort((a, b) => b.localeCompare(a)) // newest first
        .map((d) => ({
          id: `journal:${d}`,
          title: d,
          subtitle: snippet(getPageMarkdown(d), q),
          open: () => { journal.showPage(d); viewStore.set("journal"); },
        }));
    },
  },
  {
    id: "pages",
    label: "Pages",
    search: (q) => {
      const pages = pagesIndex().filter((p) => !DATE_RE.test(p.name));
      const byName = fuzzyRank(q, pages, (p) => p.name).map((r) => r.item);
      // include body matches that the name filter missed
      const extra = q
        ? pages.filter((p) => !byName.includes(p) && getPageMarkdown(p.name).toLowerCase().includes(q.toLowerCase()))
        : [];
      return [...byName, ...extra].map((p) => ({
        id: `page:${p.name}`,
        title: p.name,
        subtitle: snippet(getPageMarkdown(p.name), q),
        open: () => openPage(p.name),
      }));
    },
  },
  {
    id: "projects",
    label: "Projects",
    search: (q) =>
      fuzzyRank(q, listProjects(), (p) => `${p.name} ${p.source.kind === "local" ? p.source.path : ""}`).map(
        ({ item }) => ({
          id: `project:${item.id}`,
          title: item.name,
          subtitle: item.source.kind === "local" ? item.source.path : item.source.kind,
          open: () => openProject(item.id),
        }),
      ),
  },
  {
    id: "sessions",
    label: "Sessions",
    search: (q) => {
      const cardBySession = new Map<string, string>(); // sessionId -> state
      for (const it of listItems()) for (const sid of it.sessionIds ?? []) cardBySession.set(sid, it.state);
      return fuzzyRank(q, listSessions(), (s) => `${s.title} ${cardBySession.get(s.id) ?? ""}`).map(({ item }) => ({
        id: `session:${item.id}`,
        title: item.title,
        subtitle: cardBySession.get(item.id),
        open: () => openSessionInPanel(item.id),
      }));
    },
  },
  {
    id: "files",
    label: "Files",
    search: (q) =>
      fuzzyRank(q, listFiles(), (f) => f.path).map(({ item }) => ({
        id: `file:${item.path}`,
        title: item.title,
        subtitle: item.path,
        open: () => void openRepoFile("repo", item.path),
      })),
  },
];
```

> Confirm `listItems()` exposes `sessionIds` (cards.ts); if the field name differs, adapt the session-state join. If unavailable cheaply, drop the `subtitle`/state-match and rank sessions on `title` only — state matching is a nice-to-have, not core.

The command registry:

```typescript
const paletteCommands: Command[] = [
  { id: "new-session", title: "New session", run: () => startUntitledSession() },
  { id: "new-page", title: "New page", run: () => { /* call the existing new-page path */ } },
  { id: "toggle-outline", title: "Toggle outline", run: () => toggleOutline() },
  { id: "toggle-annotations", title: "Toggle annotations", run: () => toggleAnnotations() },
  { id: "toggle-panes", title: "Toggle panes", run: () => togglePanes() },
  { id: "view-journal", title: "Go to Journal", run: () => { journal.showJournal(); viewStore.set("journal"); } },
  { id: "view-pages", title: "Go to Pages", run: () => viewStore.set("pages") },
  { id: "view-kanban", title: "Go to Kanban", run: () => viewStore.set("kanban") },
  { id: "open-settings", title: "Open settings", run: () => openSettings() },
];
```

> Map each `run` to the real existing handler (grep for the nav-footer Show buttons, the `+ new session` handler, settings cog). Where a helper doesn't exist as a callable, extract the click handler body into a named function and call it from both places (DRY). Drop any command whose action isn't reachable rather than faking it.

Construct and bind:

```typescript
const paletteMount = document.querySelector<HTMLElement>("#palette-results")!;
const palette = createCommandPalette({
  form: searchForm!,
  input: searchInput!,
  mount: paletteMount,
  sources: searchSources,
  commands: paletteCommands,
});

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "k" || k === "p") {
    e.preventDefault();
    palette.open(e.shiftKey && k === "p" ? ">" : "");
    searchInput!.select();
  }
});
// close on outside click
document.addEventListener("click", (e) => {
  if (!searchForm!.contains(e.target as Node) && !paletteMount.contains(e.target as Node)) palette.close();
});
```

> `fuzzyScore` is used in the journal source — import it alongside `fuzzyRank`.

**Step 3: Typecheck + full web suite**

Run: `pnpm --filter @orden/web typecheck && pnpm --filter @orden/web test`
Expected: typecheck clean; all tests pass (existing 220 + new).

**Step 4: Commit**

```bash
git add apps/web/src/main.ts apps/web/index.html
git commit -m "feat: wire omnisearch + command palette into the topbar"
```

---

## Task 6: Manual verification

**Step 1: Build + run** (per `run-orden-locally` — host serves static `dist`, no HMR):

```bash
pnpm --filter @orden/web build
pnpm --filter @orden/host exec tsx apps/host/src/serve.ts
```

**Step 2: Verify in browser** (open the served URL):

- `Cmd+K` and `Cmd+P` open the dropdown; typing fans out into Journal/Pages/Projects/Sessions/Files groups in that order, each capped at 4 with "+N more".
- `Cmd+Shift+P` opens with `>` and lists commands; typing filters them.
- `↑/↓` move highlight, `Enter` opens the right destination for each group, `Esc` clears then closes, outside-click closes.
- Backspacing the leading `>` returns to search results.

**Step 3:** Report results to the user (screenshots/observations — the user can't see headless runs; open the app for them per `visual-work-show-dont-narrate`).

---

## Final: whole-repo gate

```bash
pnpm -r typecheck && pnpm -r test
```

Expected: 100% pass. Then use superpowers:finishing-a-development-branch to merge/PR.
