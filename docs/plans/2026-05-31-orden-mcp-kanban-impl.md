# Orden MCP kanban + session control — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the orden MCP server first-class tools to drive the kanban and spawn sessions, so an agent moves its own card deliberately (by instruction) instead of having state inferred from Claude hook events.

**Architecture:** The MCP server moves into its own monorepo package, `@orden/mcp` (`packages/mcp`), independent of `apps/host` but consumed by it. It exports `createMcpServer(host, ctx?)` and `handleMcpRequest(host, req, res)`; `apps/host/src/serve.ts` mounts the HTTP handler so the server still runs IN the host process and shares the live in-memory `Host` + change feed (a separate process couldn't, so the web would miss live updates). New tools (`card_*`, `session_create`, `project_list`, `panel_open`) are pure functions in the package. The calling session is identified by a spawn-injected id (`/mcp/<uuid>`), resolved to its linked card by a helper (`sessionLink`) the host's hook path also imports. All writes go through the vault, which already streams to the live board. Hooks keep the automatic working/waiting cycle; the LLM drives deliberate moves and is the only path to `complete`.

**Package resolution:** This monorepo has NO root package.json / npm workspaces. Cross-package imports resolve via per-package tsconfig `paths` and vitest `resolve.alias` (see `apps/host/tsconfig.json` + `apps/host/vitest.config.ts`). The new package mirrors `packages/host-api` exactly: `name` `@orden/mcp`, `type: module`, `main: src/index.ts`, no build step (runtime is `tsx`).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (^1.29.0), zod (^4.4.3), node:http, the existing `NodeHost` / `DiskVault` / change feed, Vitest.

**Companion design:** `docs/plans/2026-05-31-orden-mcp-kanban-design.md`.

---

## Conventions for the implementer

- Tests use the in-memory `VaultStore` fake pattern already in `apps/host/test/*`. If none exists yet, Task 1 builds it.
- Tool functions are MCP-SDK-free and return `ToolResult` (`apps/host/src/tools.ts`). `mcp.ts` is the only file that touches zod / the SDK.
- Run host tests: `npm test --prefix apps/host`. Run web tests: `npm test --prefix apps/web`. Web UI changes need a rebuild: `npm run build --prefix apps/web` (the running host serves static `dist`).
- Commit after each task. Branch first: `git switch -c mcp-kanban-tools` (do not work on `main`).
- No `git add .` — stage named files only. No Claude attribution in commit messages.

---

## Task A: Extract the MCP into `@orden/mcp`

Move the existing MCP code out of `apps/host` into a new independent package, rewire the host to consume it, and verify nothing regressed BEFORE adding any new tools.

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/vitest.config.ts`
- Create: `packages/mcp/src/index.ts` (barrel: re-export `createMcpServer`, `handleMcpRequest`)
- Move: `apps/host/src/mcp.ts` -> `packages/mcp/src/server.ts`; `apps/host/src/mcpHttp.ts` -> `packages/mcp/src/http.ts`; `apps/host/src/tools.ts` -> `packages/mcp/src/tools.ts` (and its test if present)
- Modify: `apps/host/src/serve.ts` (import `handleMcpRequest` from `@orden/mcp`)
- Modify: `apps/host/tsconfig.json` + `apps/host/vitest.config.ts` (add `@orden/mcp` -> `../../packages/mcp/src/index.ts`)

**package.json** (mirror host-api; add the SDK + zod it actually uses):

```json
{
  "name": "@orden/mcp",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run", "test:watch": "vitest", "typecheck": "tsc --noEmit" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.29.0", "zod": "^4.4.3" },
  "devDependencies": { "@types/node": "^20.12.0", "typescript": "^5.4.0", "vitest": "^1.6.0" }
}
```

**tsconfig.json** (mirror host-api's, add the path it needs):

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2022"], "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["node"],
    "paths": { "@orden/host-api": ["../../packages/host-api/src/index.ts"] }
  },
  "include": ["src", "test"]
}
```

**vitest.config.ts** — alias `@orden/host-api` to its source (copy `apps/host/vitest.config.ts`).

**Steps:**
1. Scaffold the three config files + `src/index.ts`.
2. `git mv` the three source files into `packages/mcp/src/` (rename per above) and fix their relative imports (`./tools` stays; `@orden/host-api` already aliased).
3. Add the `@orden/mcp` alias to host tsconfig + vitest; change `serve.ts` to `import { handleMcpRequest } from "@orden/mcp"`.
4. Verify: `npm test --prefix packages/mcp` (move any tools test along), `npm run typecheck --prefix apps/host`, `npm test --prefix apps/host`. The dev host (`tsx`) must still resolve `@orden/mcp` — confirm by checking the host starts (or that `serve.ts` typechecks).
5. **Commit** (`refactor: extract MCP server into @orden/mcp package`).

The remaining tasks (1, 2, 4, 5 below) now CREATE/MODIFY files under `packages/mcp/src` and `packages/mcp/test` instead of `apps/host`. Tasks 3 (settings), 7 (terminal/serve wiring), 8 (web), 9 (hooks) keep their stated `apps/*` locations; the `sessionLink` helper (Task 1) lives in `packages/mcp/src` and is imported by `apps/host/src/hooks.ts` via the new alias.

---

## Task 0: Branch (done)

Already on branch `mcp-kanban-tools` with the plan docs committed. Skip.

## Task 0 (original): Branch

**Step 1:** `git switch -c mcp-kanban-tools`

**Step 2:** Confirm clean: `git status` shows only the two new plan docs untracked. Stage + commit them:

```bash
git add docs/plans/2026-05-31-orden-mcp-kanban-design.md docs/plans/2026-05-31-orden-mcp-kanban-impl.md
git commit -m "docs: orden MCP kanban tools design + plan"
```

---

## Task 1: Session/card resolution helper

The hook path (`hooks.ts:95-114`) already maps a Claude conversation id to its orden session and linked card by scanning the vault. Extract that so the MCP tools reuse one resolver, and add target (id-or-title) lookup.

**Files:**
- Create: `apps/host/src/sessionLink.ts`
- Create: `apps/host/test/sessionLink.test.ts`
- Create (if absent): `apps/host/test/fakeVault.ts`
- Modify: `apps/host/src/hooks.ts` (use the shared resolver)

**Step 1: fakeVault helper** (skip if one already exists in test/)

```ts
// apps/host/test/fakeVault.ts
import type { VaultStore } from "@orden/host-api";

export function fakeVault(seed: Record<string, Record<string, unknown>> = {}): VaultStore {
  const store = new Map<string, Map<string, unknown>>();
  for (const [ns, kv] of Object.entries(seed)) store.set(ns, new Map(Object.entries(kv)));
  const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
  return {
    async get<T>(ns: string, key: string) { return (nsMap(ns).get(key) ?? null) as T | null; },
    async set<T>(ns: string, key: string, value: T) { nsMap(ns).set(key, value); },
    async list(ns: string) { return [...nsMap(ns).keys()]; },
    async delete(ns: string, key: string) { nsMap(ns).delete(key); },
  };
}
```

**Step 2: Write failing tests** in `sessionLink.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import { sessionForConversation, cardForSession, findCard } from "../src/sessionLink";

const seed = () => fakeVault({
  sessions: { s1: { id: "s1", conversationId: "uuid-1", projectId: "p1" } },
  cards: {
    c1: { id: "c1", title: "Fix login", state: "in-progress", projectId: "p1", sessionIds: ["s1"] },
    c2: { id: "c2", title: "Write docs", state: "planning", projectId: "p1", sessionIds: [] },
  },
});

describe("sessionLink", () => {
  it("maps a conversation id to its orden session", async () => {
    expect((await sessionForConversation(seed(), "uuid-1"))?.id).toBe("s1");
    expect(await sessionForConversation(seed(), "nope")).toBeNull();
  });
  it("finds the card linked to a session", async () => {
    expect((await cardForSession(seed(), "s1"))?.id).toBe("c1");
  });
  it("findCard resolves by id", async () => {
    expect((await findCard(seed(), "c2")).card?.id).toBe("c2");
  });
  it("findCard resolves by exact title (case-insensitive)", async () => {
    expect((await findCard(seed(), "fix login")).card?.id).toBe("c1");
  });
  it("findCard returns candidates on a miss", async () => {
    const r = await findCard(seed(), "logan");
    expect(r.card).toBeNull();
    expect(r.candidates).toContain("Fix login");
  });
});
```

**Step 3: Run — expect fail** (`sessionLink` not found): `npm test --prefix apps/host -- sessionLink`

**Step 4: Implement** `apps/host/src/sessionLink.ts`:

```ts
import type { Host } from "@orden/host-api";

export interface SessionRec { id: string; conversationId?: string; projectId?: string; [k: string]: unknown; }
export interface CardRec { id: string; title: string; state: string; projectId?: string; sessionIds?: string[]; sessionId?: string; notes?: string; [k: string]: unknown; }

const links = (c: CardRec): string[] => (Array.isArray(c.sessionIds) ? c.sessionIds : c.sessionId ? [c.sessionId] : []);

export async function sessionForConversation(vault: Host["vault"], conversationId: string): Promise<SessionRec | null> {
  for (const id of await vault.list("sessions")) {
    const rec = await vault.get<SessionRec>("sessions", id);
    if (rec?.conversationId === conversationId) return rec;
  }
  return null;
}

export async function cardForSession(vault: Host["vault"], ordenSessionId: string): Promise<CardRec | null> {
  for (const id of await vault.list("cards")) {
    const card = await vault.get<CardRec>("cards", id);
    if (card && links(card).includes(ordenSessionId)) return card;
  }
  return null;
}

export interface FindResult { card: CardRec | null; candidates: string[]; }

export async function findCard(vault: Host["vault"], target: string): Promise<FindResult> {
  const ids = await vault.list("cards");
  const cards = (await Promise.all(ids.map((id) => vault.get<CardRec>("cards", id)))).filter((c): c is CardRec => !!c);
  const byId = cards.find((c) => c.id === target);
  if (byId) return { card: byId, candidates: [] };
  const t = target.trim().toLowerCase();
  const byTitle = cards.find((c) => c.title.trim().toLowerCase() === t);
  if (byTitle) return { card: byTitle, candidates: [] };
  const candidates = cards.filter((c) => c.title.toLowerCase().includes(t)).map((c) => c.title).slice(0, 5);
  return { card: null, candidates };
}
```

**Step 5: Run — expect pass.** **Step 6:** Refactor `hooks.ts` `applyState` to call `sessionForConversation` + `cardForSession`; re-run host tests. **Step 7: Commit** (`feat: shared session/card resolver`).

---

## Task 2: card_get, card_move, card_complete, card_create

**Files:** Modify `apps/host/src/tools.ts`; create `apps/host/test/cardTools.test.ts`.

`card_move` accepts only `planning | in-progress | blocked`. `card_complete` is the only path to `complete`. Writes patch one field on the stored object. The optional `note` on `card_move` appends `"<state>: <note>"` to `notes`.

**Step 1: Failing tests** — cover: move across the three states patches state and keeps other fields; `card_move` with `complete` is rejected (the function signature only accepts the three, so this is enforced in `mcp.ts` Task 6 — here test that `cardComplete` sets complete); `cardGet` by title and the current-session form (pass a resolved card in); `cardCreate` writes a card in `planning` with a generated `item_*` id and the resolved project; `note` appends to `notes`.

```ts
// representative cases
it("cardMove patches state, keeps title/sessionIds", async () => {
  const v = seed();
  await cardMove(v, "c1", "blocked", "waiting on design");
  const c = await v.get("cards", "c1");
  expect(c.state).toBe("blocked");
  expect(c.title).toBe("Fix login");
  expect(c.sessionIds).toEqual(["s1"]);
  expect(c.notes).toContain("blocked: waiting on design");
});
it("cardComplete reaches complete", async () => {
  const v = seed(); await cardComplete(v, "c1");
  expect((await v.get("cards", "c1")).state).toBe("complete");
});
it("cardCreate lands in planning with item_ id", async () => {
  const v = seed(); const r = await cardCreate(v, "New thing", "p1");
  const ids = await v.list("cards");
  const created = ids.find((i) => i.startsWith("item_"));
  expect(created).toBeTruthy();
  expect((await v.get("cards", created)).state).toBe("planning");
});
```

**Step 2: Run — fail. Step 3: Implement** in `tools.ts` (functions take `vault: Host["vault"]`, not the SDK):

```ts
import { findCard, type CardRec } from "./sessionLink";

const MOVABLE = ["planning", "in-progress", "blocked"] as const;
export type MovableState = (typeof MOVABLE)[number];

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Date.now() % 1e6).toString(36)}${Math.trunc(performance.now()).toString(36)}`;
}

async function patchCard(vault: Host["vault"], target: string, patch: Partial<CardRec>): Promise<ToolResult> {
  const { card, candidates } = await findCard(vault, target);
  if (!card) return text(`no card matches "${target}"${candidates.length ? `; closest: ${candidates.join(", ")}` : ""}`);
  const next = { ...card, ...patch };
  await vault.set("cards", card.id, next);
  return text(`card "${next.title}" -> ${next.state}`);
}

export async function cardGet(vault: Host["vault"], target: string): Promise<ToolResult> {
  const { card, candidates } = await findCard(vault, target);
  if (!card) return text(`no card matches "${target}"${candidates.length ? `; closest: ${candidates.join(", ")}` : ""}`);
  return text(JSON.stringify({ id: card.id, title: card.title, state: card.state, project: card.projectId, notes: card.notes ?? "" }, null, 2));
}

export async function cardMove(vault: Host["vault"], target: string, state: MovableState, note?: string): Promise<ToolResult> {
  const { card } = await findCard(vault, target);
  const notes = note && card ? `${card.notes ? card.notes + "\n" : ""}${state}: ${note}` : card?.notes;
  return patchCard(vault, target, { state, ...(note ? { notes } : {}) });
}

export async function cardComplete(vault: Host["vault"], target: string): Promise<ToolResult> {
  return patchCard(vault, target, { state: "complete" });
}

export async function cardCreate(vault: Host["vault"], title: string, projectId: string, notes = ""): Promise<ToolResult> {
  const card: CardRec = { id: rid("item"), title: title.trim(), state: "planning", projectId, notes, sessionIds: [] };
  await vault.set("cards", card.id, card);
  return text(`created card "${card.title}" in planning (${card.id})`);
}
```

(Note: `rid` must avoid `Date.now()` collisions only across rapid calls; the design's `item_<time36>_<rand>` is the intent. Keep it simple and unique.)

**Step 4: Run — pass. Step 5: Commit** (`feat: card_get/move/complete/create tool fns`).

---

## Task 3: session_create + launch setting

**Files:** Modify `apps/host/src/tools.ts`; modify `apps/web/src/settings.ts` (add `sessionAutoLaunch`); create tests; (launch wiring lands in Task 7 alongside the spawn path).

`sessionCreate` mirrors `apps/web/src/sessions.ts:createSession`: write a `Session` (ns `sessions`) with `initialPrompt = prompt ?? title`, then a linked planning card (reuse `cardCreate`, then link the session id). It returns the new session id. Whether the TUI launches is decided by the consumer using the `sessionAutoLaunch` setting (default true) — the tool fn just records intent; Task 7 spawns.

**Step 1: Failing test** — `sessionCreate` writes a `sess_*` session and a linked planning card carrying that session id; project defaults are resolved by the caller (pass `projectId` in).

**Step 2/3: Implement** `sessionCreate(vault, { title, projectId, prompt, agent })`: write session record, create card, set `card.sessionIds=[sessionId]`, persist both.

**Step 4:** Add `sessionAutoLaunch: boolean` (default `true`) to `Settings` + `coerce` in `settings.ts`; host reads it via `vault.get("settings","app")`.

**Step 5: Run — pass. Step 6: Commit** (`feat: session_create tool + autoLaunch setting`).

---

## Task 4: project_list

**Files:** Modify `tools.ts`; add tests. Returns `id + name` per project from ns `projects` (sorted by name). Also add a `resolveProject(vault, idOrName?)` helper used by `cardCreate`/`sessionCreate` to accept a name or id, defaulting to the session's project, else `homeroom`.

**Step 1–4:** test (list returns seeded projects; resolveProject matches by name case-insensitively, falls back to homeroom), implement, run, **commit** (`feat: project_list + project resolution`).

---

## Task 5: panel_open

**Files:** Modify `tools.ts`; add tests.

Writes a view-intent record: `vault.set("ui", "panel-intent", { kind, target, nonce })`. `kind` is `doc | page | kanban | card`; `nonce` is a monotonically-increasing/unique value so repeat opens still differ. The web reacts in Task 8.

**Step 1–4:** test (writes `ui/panel-intent` with the given kind/target and a fresh nonce each call), implement, run, **commit** (`feat: panel_open tool`).

---

## Task 6: Register tools + server instructions

**Files:** Modify `apps/host/src/mcp.ts`.

Register `card_get`, `card_move`, `card_complete`, `card_create`, `session_create`, `project_list`, `panel_open` with zod schemas. `card_move`'s `state` is `z.enum(["planning","in-progress","blocked"])` — this is where `"complete"` is rejected at the boundary. No-target forms (`card_get`, `card_move`) default to the bound session's card (Task 7 provides the binding via context).

Add server `instructions` to the `McpServer` constructor:

```
You operate the orden kanban for the current session.
- Move your card as work progresses: card_move("in-progress") when you start, card_move("blocked") only when you genuinely need the user.
- NEVER call card_complete unless the user explicitly tells you to finish or close the item.
- Capture stray ideas with session_create; they land in planning for later.
- Use panel_open to show the user a doc, page, or the board when it helps.
```

**Step 1:** Manual check — `npm run build --prefix apps/host` compiles. **Step 2:** Start/confirm the host, `tools/list` over MCP shows the new tools (or assert via an SDK in-memory client test if quick). **Step 3: Commit** (`feat: register kanban/session MCP tools + instructions`).

---

## Task 7: Per-session binding + launch wiring

**Files:** Modify `apps/host/src/mcpHttp.ts`, `apps/host/src/mcp.ts`, `apps/host/src/terminal.ts`.

**Binding:** in `mcpHttp.ts`, read the orden session id from the request — path `POST /mcp/<uuid>` (preferred) or header `x-orden-session`. Pass it into `createMcpServer(host, { conversationId })` so no-target `card_get`/`card_move` resolve via `sessionForConversation` + `cardForSession`. When absent, the no-target forms return "pass a target; this client isn't bound to a session."

**Spawn injection:** in `terminal.ts` `buildCommand`, when minting a claude session (`claude --session-id <id>`), also register a session-scoped MCP endpoint so this agent's calls carry `<id>`. Implement by writing a per-session `.mcp.json` (or `claude mcp add --transport http orden-session http://127.0.0.1:<port>/mcp/<id>` in the launch command) pointing at the scoped path. Keep the global registration working for ad-hoc use.

**Launch:** the session-open path (or a small host action invoked by `session_create` when `sessionAutoLaunch` is true) spawns the tmux TUI. Since `session_create` runs in the host, gate the spawn on `(await vault.get("settings","app")).sessionAutoLaunch !== false`.

**Steps:** unit-test the `mcpHttp` id parse (path + header) where practical; manual-verify the spawn injection end to end in Task 9. **Commit** (`feat: bind MCP calls to spawning session; launch on create`).

---

## Task 8: Web — panel intent + settings toggle

**Files:** Modify `apps/web/src/main.ts` (`onVaultChange`), add a settings control, then rebuild.

**Step 1:** In `onVaultChange`, add `case "ui":` — when `key === "panel-intent"`, read the record and navigate: `doc` -> `openRepoFile(target)`; `page` -> `openPage(target)`; `kanban` -> `viewStore.set("kanban")` + `refreshBoard()`; `card` -> open the board and focus the card (reuse the card-modal open path). Guard with `!view.hasFocus()` so it never interrupts active typing, matching the existing files-change guard (`main.ts:1057`).

**Step 2:** Add a `sessionAutoLaunch` checkbox to the settings panel wired to `saveSettings`.

**Step 3:** Test the navigation switch in `apps/web/test` with a fake intent record + a stubbed view store.

**Step 4:** `npm run build --prefix apps/web`. **Step 5: Commit** (`feat: web reacts to panel-intent; autoLaunch toggle`).

---

## Task 9: Guard hooks so they never clobber `complete`

**Files:** Modify `apps/host/src/hooks.ts`; update its test.

The activity hooks STAY — they encode the agreed semantics: `UserPromptSubmit -> in-progress` ("it's working"), `Stop` / waiting-notification -> `blocked` ("done with the turn / waiting on you"). The agent cannot set `blocked` as its own last act, so the hook is the right mechanism. What changes: `complete` is terminal and user-owned, so a hook must NEVER move a card that is already `complete` (otherwise the next `Stop` undoes a completion).

**Step 1: Failing test** — a card in `complete` is left untouched when `applyState(host, conv, "blocked")` runs.

**Step 2: Implement** — in `applyState` (`hooks.ts`), after resolving the card, `if (card.state === "complete") return;` before writing. Also drop `"complete"` from the hook's `ALLOWED` set: hooks may only set `planning | in-progress | blocked`; completion comes solely from `card_complete`.

**Step 3: Run — pass. Step 4:** update the header comment to describe the division of labor (hooks = automatic working/waiting cycle; LLM `card_*` = deliberate moves + the only path to complete). **Commit** (`fix: hooks never move a completed card; complete is LLM-only`).

---

## Task 10: Live verification

Assume services are running. Rebuild web (Task 8) and ensure the host picked up the new code.

- From a bound session: ask the agent to `card_move("in-progress")` then `card_move("blocked")` — the live board reflects each, no lurch on plain turn-end.
- `card_move("complete")` is refused; `card_complete` (on explicit instruction) completes.
- `session_create` for another project shows a planning card instantly; with `sessionAutoLaunch` on, the TUI starts.
- `panel_open("docs/plans/2026-05-31-orden-mcp-kanban-design.md")` opens the design live in the main panel (replacing the last-doc bridge used to open it the first time).

Update `MEMORY.md` with a pointer if the agent-bus memory needs revising (the card-state mechanism changed).
