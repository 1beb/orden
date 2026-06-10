# Remote Directory Browser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the host-side native `zenity`/`kdialog` directory picker with an in-app directory browser that works for every client, including remote/mobile, by having the host return directory listings (`files.listDir`) that the web app renders.

**Architecture:** Host owns the data (a new `listDir` on `FileSource` over the existing generic RPC proxy — no transport changes). The one web build renders a breadcrumb + folder-list navigator (`directoryBrowser.ts`) that writes the chosen absolute path back into the project modal's path input. The native picker path (`pickDirectory.ts`, the `pickDirectory` capability/methods) is deleted.

**Tech Stack:** TypeScript, pnpm workspaces, vitest (host: node env; web: happy-dom), vanilla DOM (no framework).

**Design doc:** `docs/plans/2026-06-04-remote-directory-browser-design.md`

**Baseline note:** 5 pre-existing host watcher test failures (`multiRootWatcher.test.ts`, `nodeHost.test.ts` MultiRootWatcher case) exist on `main` and are tracked separately (orden card "Fix flaky/failing MultiRootWatcher host tests"). They are unrelated to this work — do not treat them as regressions. Every other test must stay green.

**Ordering principle:** Tasks 1-5 are additive (old `pickDirectory` path stays intact, so every commit typechecks and tests pass). Task 6 does the removal in one sweep once the replacement works end to end.

---

### Task 1: Host `listDir` data contract + implementation

**Files:**
- Modify: `packages/host-api/src/index.ts` (add `DirEntry`, `DirListing`, `listDir` to `FileSource` — keep `pickDirectory` for now)
- Modify: `apps/host/src/fsFiles.ts` (implement `listDir`)
- Test: `apps/host/test/fsFiles.test.ts`

**Step 1: Write the failing test**

Append to `apps/host/test/fsFiles.test.ts` (the existing `root()` helper builds a temp dir from a file map; `mkdirSync` is already imported):

```ts
import { homedir } from "node:os";

describe("FsFiles.listDir", () => {
  test("lists only visible sub-directories, sorted, with files filtered out", async () => {
    const d = root({
      "zebra/keep.md": "z",
      "alpha/keep.md": "a",
      "a-file.txt": "x",
      ".hidden/keep.md": "h",
      "node_modules/pkg/i.js": "n",
    });
    const fs = new FsFiles(async () => undefined); // resolver irrelevant: listDir is standalone
    const listing = await fs.listDir(d);
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "zebra"]);
    expect(listing.entries[0].path).toBe(join(d, "alpha"));
    expect(listing.path).toBe(d);
    expect(listing.parent).toBe(dirname(d));
  });

  test("defaults to $HOME when no path is given", async () => {
    const fs = new FsFiles(async () => undefined);
    const listing = await fs.listDir();
    expect(listing.path).toBe(homedir());
  });

  test("parent is null at the filesystem root", async () => {
    const fs = new FsFiles(async () => undefined);
    const listing = await fs.listDir("/");
    expect(listing.parent).toBeNull();
  });

  test("rejects on an unreadable path", async () => {
    const fs = new FsFiles(async () => undefined);
    await expect(fs.listDir("/no/such/dir/here")).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/host && pnpm vitest run test/fsFiles.test.ts`
Expected: FAIL — `fs.listDir is not a function` (and TS error: property missing on `FileSource`).

**Step 3: Implement**

In `packages/host-api/src/index.ts`, add near `FileEntry`:

```ts
export interface DirEntry {
  /** Basename, e.g. "orden". */
  name: string;
  /** Absolute path, e.g. "/home/b/projects/orden". */
  path: string;
}

export interface DirListing {
  /** Absolute, normalized path of the directory listed. */
  path: string;
  /** Absolute parent path, or null at the filesystem root "/". */
  parent: string | null;
  /** Immediate sub-directories only, sorted name-ascending. */
  entries: DirEntry[];
}
```

Add to the `FileSource` interface (alongside the existing methods; leave `pickDirectory` for now):

```ts
  /**
   * List the immediate sub-directories of an absolute host path (files omitted;
   * dotdirs and build dirs filtered), for the in-app project-folder browser.
   * Standalone — not scoped to a project. Omitted/empty path lists $HOME.
   * Rejects on an unreadable path; the RPC layer surfaces that to the client.
   */
  listDir(path?: string): Promise<DirListing>;
```

In `apps/host/src/fsFiles.ts`, add imports and the method. Update the top import line `import { join, relative, dirname, sep } from "node:path";` to also pull `resolve`, and add `import { homedir } from "node:os";`. Import the new types: change the host-api import to `import type { FileSource, FileEntry, DirListing } from "@orden/host-api";`. Then add inside the `FsFiles` class:

```ts
  // Standalone directory listing for the project-folder browser. Unlike
  // list/read/write this is NOT project-rooted: it walks an absolute host path
  // so the user can browse anywhere when picking a folder. Directories only;
  // dotdirs + SKIP_DIRS filtered; sorted (readdir order is filesystem order).
  async listDir(path?: string): Promise<DirListing> {
    const dir = resolve(path && path.trim() ? path : homedir());
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = dirents
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, entries };
  }
```

**Step 4: Run test to verify it passes**

Run: `cd apps/host && pnpm vitest run test/fsFiles.test.ts`
Expected: PASS (all `listDir` tests + existing `FsFiles` tests).

**Step 5: Commit**

```bash
git add packages/host-api/src/index.ts apps/host/src/fsFiles.ts apps/host/test/fsFiles.test.ts
git commit -m "feat(host): add FileSource.listDir directory listing"
```

---

### Task 2: RPC pass-through for `listDir`

**Files:**
- Test: `apps/host/test/rpc.test.ts`

**Step 1: Write the failing test**

The `rpc.test.ts` harness wires a real `NodeHost` to a `client` via in-process `dispatch` (see its `beforeEach`). It seeds `root = mkdtemp(...)` as the vault root. Add a test that the client's `files.listDir` round-trips. Append inside the existing top-level `describe`:

```ts
test("files.listDir round-trips through the RPC client", async () => {
  // root is a real temp dir created in beforeEach; list it through the client.
  const listing = await client.files.listDir(root);
  expect(listing.path).toBe(root);
  expect(Array.isArray(listing.entries)).toBe(true);
});
```

(If `root` is not in scope at that position, use the same variable the surrounding tests use for the temp dir — check the file's `beforeEach`.)

**Step 2: Run test to verify it fails, then passes**

Run: `cd apps/host && pnpm vitest run test/rpc.test.ts`
Expected: PASS immediately — the generic `capProxy` already forwards any `files` method. This test documents/locks the contract rather than driving new code. If it fails, the proxy or `listDir` is misnamed; fix that.

**Step 3: Commit**

```bash
git add apps/host/test/rpc.test.ts
git commit -m "test(host): lock listDir RPC pass-through contract"
```

---

### Task 3: browserHost stub + `browseDirectories` capability

**Files:**
- Modify: `packages/host-api/src/index.ts` (add `browseDirectories` to `HostCapabilities`)
- Modify: `apps/web/src/host/browserHost.ts` (`LocalFiles.listDir` stub; keep `pickDirectory` for now)
- Modify: `apps/host/src/nodeHost.ts` (add `browseDirectories: true` to capabilities; keep `pickDirectory` line for now)
- Test: `apps/web/test/<new or existing capabilities test>` — assert browserHost omits `browseDirectories`.

**Step 1: Write the failing test**

Add to an existing web host test (e.g. create `apps/web/test/browseCapability.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";

describe("BrowserHost directory browsing", () => {
  it("does not advertise browseDirectories", () => {
    expect(new BrowserHost().capabilities().browseDirectories).toBeFalsy();
  });

  it("listDir throws (no real filesystem)", async () => {
    await expect(new BrowserHost().files.listDir()).rejects.toThrow();
  });
});
```

**Step 2: Run to verify it fails**

Run: `cd apps/web && pnpm vitest run test/browseCapability.test.ts`
Expected: FAIL — `listDir is not a function`.

**Step 3: Implement**

In `packages/host-api/src/index.ts` `HostCapabilities`, add (next to the soon-to-be-removed `pickDirectory`):

```ts
  /**
   * True when the host exposes a real filesystem the in-app directory browser
   * can list (files.listDir). The project modal shows "Browse…" only then.
   * Absent on the in-browser host.
   */
  browseDirectories?: boolean;
```

In `apps/web/src/host/browserHost.ts` `LocalFiles`, add:

```ts
  async listDir(): Promise<never> {
    throw new Error("BrowserHost: no filesystem");
  }
```

(Adjust the return type to match the interface — `Promise<DirListing>` with a throw body is fine; `Promise<never>` also satisfies it. Import `DirListing` as a type if needed.)

In `apps/host/src/nodeHost.ts` `capabilities()`, add `browseDirectories: true,` (leave the `pickDirectory: hasDirectoryPicker()` line until Task 6).

**Step 4: Run to verify it passes**

Run: `cd apps/web && pnpm vitest run test/browseCapability.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/host-api/src/index.ts apps/web/src/host/browserHost.ts apps/host/src/nodeHost.ts apps/web/test/browseCapability.test.ts
git commit -m "feat: add browseDirectories capability + browserHost listDir stub"
```

---

### Task 4: Web `directoryBrowser` navigator

**Files:**
- Create: `apps/web/src/directoryBrowser.ts`
- Modify: `apps/web/src/projects.ts` (add `canBrowseDirectories()` and a `listDir()` host wrapper; keep `canPickDirectory`/`pickDirectory` for now)
- Test: `apps/web/test/directoryBrowser.test.ts`

**Design for testability:** `browseForDirectory` takes an injectable lister (defaulting to the host-backed one), mirroring how `selectHost` injects factories. The test passes a fake lister and drives the DOM.

**Step 1: Write the failing test**

Create `apps/web/test/directoryBrowser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DirListing } from "@orden/host-api";
import { browseForDirectory } from "../src/directoryBrowser";

// A tiny in-memory filesystem keyed by absolute path.
const FS: Record<string, DirListing> = {
  "/home/b": {
    path: "/home/b",
    parent: "/home",
    entries: [
      { name: "projects", path: "/home/b/projects" },
      { name: "docs", path: "/home/b/docs" },
    ],
  },
  "/home/b/projects": {
    path: "/home/b/projects",
    parent: "/home/b",
    entries: [{ name: "orden", path: "/home/b/projects/orden" }],
  },
  "/": { path: "/", parent: null, entries: [{ name: "home", path: "/home" }] },
};
const fakeList = async (p?: string): Promise<DirListing> => {
  const key = p ?? "/home/b";
  const l = FS[key];
  if (!l) throw new Error(`ENOENT: ${key}`);
  return l;
};

const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".dirbrowser__row")];
const byText = (t: string) => rows().find((r) => r.textContent?.includes(t));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("browseForDirectory", () => {
  it("descends into a folder and selects the current directory", async () => {
    const picked = browseForDirectory("/home/b", fakeList);
    await settle();
    // Listing /home/b: a ".." row plus two folders.
    expect(byText("projects")).toBeTruthy();
    byText("projects")!.click();
    await settle();
    expect(byText("orden")).toBeTruthy();
    // Select the current dir (/home/b/projects) without descending into orden.
    document.querySelector<HTMLButtonElement>(".dirbrowser__select")!.click();
    expect(await picked).toBe("/home/b/projects");
    expect(document.querySelector(".dirbrowser")).toBeNull(); // overlay removed
  });

  it("hides the .. row at the filesystem root", async () => {
    browseForDirectory("/", fakeList);
    await settle();
    expect(byText(".. ")).toBeFalsy();
  });

  it("shows an error inline without clearing the prior listing", async () => {
    browseForDirectory("/home/b", fakeList);
    await settle();
    // FS has no /home/b/docs listing -> lister throws.
    byText("docs")!.click();
    await settle();
    expect(document.querySelector(".dirbrowser__error")?.textContent).toContain("ENOENT");
    expect(byText("projects")).toBeTruthy(); // previous listing still shown
  });

  it("resolves null when dismissed", async () => {
    const picked = browseForDirectory("/home/b", fakeList);
    await settle();
    document.querySelector<HTMLButtonElement>(".dirbrowser__close")!.click();
    expect(await picked).toBeNull();
  });
});
```

**Step 2: Run to verify it fails**

Run: `cd apps/web && pnpm vitest run test/directoryBrowser.test.ts`
Expected: FAIL — module/function not found.

**Step 3: Implement**

Add to `apps/web/src/projects.ts` (alongside existing exports; do NOT remove the old ones yet):

```ts
import type { DirListing } from "@orden/host-api";

// True when the connected host exposes a real filesystem to browse. The project
// modal shows its "Browse…" button only then.
export function canBrowseDirectories(): boolean {
  return host?.capabilities().browseDirectories ?? false;
}

// List a host directory for the in-app folder browser. Throws (surfaced inline
// by the browser) on an unreadable path.
export function listDir(path?: string): Promise<DirListing> {
  if (!host) throw new Error("No host connected");
  return host.files.listDir(path);
}
```

Create `apps/web/src/directoryBrowser.ts`:

```ts
// In-app directory browser for picking a project folder on the HOST. The host
// returns listings (files.listDir); this renders them as a breadcrumb + folder
// list so it works for any client, including remote/mobile — unlike the old
// native zenity dialog, which only rendered on the host's own screen.
import type { DirListing } from "@orden/host-api";
import { listDir as hostListDir } from "./projects";

type Lister = (path?: string) => Promise<DirListing>;

// Opens the navigator as a sub-overlay; resolves to the chosen absolute path,
// or null when dismissed. `startPath` seeds the first listing ($HOME if absent).
// `list` is injectable for tests; defaults to the host-backed lister.
export function browseForDirectory(
  startPath?: string,
  list: Lister = hostListDir,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay dirbrowser";

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") finish(null);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKey);

    const modal = document.createElement("div");
    modal.className = "preview-modal dirbrowser__modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    // Header: current path + close.
    const header = document.createElement("header");
    header.className = "dirbrowser__header";
    const pathLabel = document.createElement("span");
    pathLabel.className = "dirbrowser__path";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dirbrowser__close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => finish(null));
    header.append(pathLabel, closeBtn);

    const listEl = document.createElement("div");
    listEl.className = "dirbrowser__list";
    const errorEl = document.createElement("p");
    errorEl.className = "dirbrowser__error";
    errorEl.hidden = true;

    // Footer: select the current directory.
    const footer = document.createElement("div");
    footer.className = "dirbrowser__footer";
    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "dirbrowser__select preview-modal__btn--primary";
    selectBtn.textContent = "Select this folder";
    footer.append(selectBtn);

    modal.append(header, listEl, errorEl, footer);
    overlay.append(modal);
    document.body.append(overlay);

    let current: DirListing | null = null;

    const navigate = async (path?: string): Promise<void> => {
      listEl.setAttribute("aria-busy", "true");
      try {
        const listing = await list(path);
        current = listing;
        pathLabel.textContent = listing.path;
        errorEl.hidden = true;
        selectBtn.disabled = false;
        const rows: HTMLElement[] = [];
        if (listing.parent !== null) {
          rows.push(row(".. (up)", () => void navigate(listing.parent!)));
        }
        for (const entry of listing.entries) {
          rows.push(row(`${entry.name}/`, () => void navigate(entry.path)));
        }
        listEl.replaceChildren(...rows);
      } catch (err) {
        // Keep the prior listing visible; just show the error.
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        errorEl.hidden = false;
      } finally {
        listEl.removeAttribute("aria-busy");
      }
    };

    selectBtn.disabled = true;
    selectBtn.addEventListener("click", () => {
      if (current) finish(current.path);
    });

    void navigate(startPath);
  });
}

function row(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dirbrowser__row";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
```

Add minimal styles to `apps/web/src/styles.css` (folder rows full-width, tap-friendly; error red). Keep it short — reuse `.preview-overlay`/`.preview-modal` for the shell:

```css
.dirbrowser__list { max-height: 50vh; overflow: auto; display: flex; flex-direction: column; }
.dirbrowser__row { display: flex; justify-content: space-between; width: 100%; text-align: left;
  padding: 0.6rem 0.75rem; background: none; border: 0; border-bottom: 1px solid var(--border, #2a2a2a);
  color: inherit; font: inherit; cursor: pointer; }
.dirbrowser__row:hover { background: var(--hover, rgba(255,255,255,0.06)); }
.dirbrowser__path { font-family: monospace; font-size: 0.85rem; overflow-wrap: anywhere; }
.dirbrowser__error { color: var(--danger, #e5534b); margin: 0.5rem 0.75rem; }
.dirbrowser__footer { display: flex; justify-content: flex-end; padding: 0.75rem; }
```

(Use existing CSS variables if the codebase defines them; otherwise the fallbacks above suffice.)

**Step 4: Run to verify it passes**

Run: `cd apps/web && pnpm vitest run test/directoryBrowser.test.ts`
Expected: PASS (all 4 cases).

**Step 5: Commit**

```bash
git add apps/web/src/directoryBrowser.ts apps/web/src/projects.ts apps/web/src/styles.css apps/web/test/directoryBrowser.test.ts
git commit -m "feat(web): in-app directory browser navigator"
```

---

### Task 5: Wire the project modal to the new browser

**Files:**
- Modify: `apps/web/src/projectModal.ts` (swap `canPickDirectory`/`pickDirectory` for `canBrowseDirectories`/`browseForDirectory`)

**Step 1: Update imports**

In `apps/web/src/projectModal.ts`, change the import block:

```ts
import { addProject, updateProject, canBrowseDirectories, type Project } from "./projects";
import { browseForDirectory } from "./directoryBrowser";
```

**Step 2: Update the gate + handler**

Replace `if (canPickDirectory()) {` with `if (canBrowseDirectories()) {`, and the click handler body:

```ts
    browse.addEventListener("click", async () => {
      browse.disabled = true;
      try {
        const picked = await browseForDirectory(pathInput.value.trim() || undefined);
        if (picked) {
          pathInput.value = picked;
          pathInput.dispatchEvent(new Event("input"));
        }
      } finally {
        browse.disabled = false;
      }
    });
```

**Step 3: Typecheck + web tests**

Run: `cd apps/web && pnpm typecheck && pnpm vitest run`
Expected: PASS. (If a `projectModal` test referenced `canPickDirectory`, update it to `canBrowseDirectories` here.)

**Step 4: Commit**

```bash
git add apps/web/src/projectModal.ts
git commit -m "feat(web): project modal uses in-app directory browser"
```

---

### Task 6: Remove the native picker path

**Files:**
- Delete: `apps/host/src/pickDirectory.ts`
- Delete: `apps/host/test/pickDirectory.test.ts` (if present)
- Modify: `packages/host-api/src/index.ts` (drop `pickDirectory` from `FileSource` + `pickDirectory` from `HostCapabilities`)
- Modify: `apps/host/src/fsFiles.ts` (drop `pickDirectory` method + its import)
- Modify: `apps/host/src/nodeHost.ts` (drop `hasDirectoryPicker` import + `pickDirectory:` capability line)
- Modify: `apps/web/src/host/browserHost.ts` (drop `pickDirectory` method)
- Modify: `apps/web/src/projects.ts` (drop `canPickDirectory` + `pickDirectory`)
- Modify: any tests referencing the removed names (`apps/host/test/*`, `apps/web/test/selectHost.test.ts`, `apps/web/test/projects.test.ts`)

**Step 1: Find every reference**

Run: `cd <repo root> && grep -rn "pickDirectory\|hasDirectoryPicker\|canPickDirectory" packages apps --include=*.ts | grep -v node_modules`
Expected: a finite list. Each must be removed or, in tests, deleted/retargeted.

**Step 2: Delete + edit**

Remove the files and members listed above. For `fsFiles.ts`, delete the `pickDirectory` method and the `import { pickDirectory } from "./pickDirectory";` line. For `nodeHost.ts`, delete the `import { hasDirectoryPicker } from "./pickDirectory";` line and the `pickDirectory: hasDirectoryPicker(),` capability line (leave `browseDirectories: true`).

**Step 3: Typecheck the whole workspace**

Run: `cd <repo root> && pnpm -r typecheck`
Expected: PASS, with zero remaining references (compiler flags any missed call site).

**Step 4: Full test suite**

Run: `cd <repo root> && pnpm -r test`
Expected: All pass EXCEPT the 5 pre-existing watcher failures noted in the baseline. No new failures.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove native zenity directory picker"
```

(Note: `git add -A` here is scoped to this worktree's intended deletions; verify `git status` lists only the files above before committing — per the repo's no-blind-add rule, confirm the set first.)

---

### Final verification

- Run: `cd <repo root> && pnpm -r typecheck && pnpm -r test`
- Confirm only the 5 tracked watcher tests fail; everything else green.
- Manual smoke (optional, with a running host): open the project modal, click Browse, confirm the navigator lists the host's `$HOME`, descends, and Select fills the path input.
- Then use superpowers:finishing-a-development-branch to integrate.
