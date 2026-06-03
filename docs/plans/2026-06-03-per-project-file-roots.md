# Per-Project File Roots (H2.2) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the host's `FileSource` resolve files per project (each local project rooted at its own folder) instead of a single host-wide `filesRoot`, so every folder-backed project — not just the one equal to `filesRoot` — shows and opens its files. Also furl the nav "Files" section into a closed-by-default "Recent files" and stop auto-opening a repo file at boot.

**Architecture:** `FsFiles` swaps its single `root: string` for a `resolveRoot(projectId) => Promise<string|undefined>` backed by the shared vault `projects` namespace (single source of truth); `"repo"` aliases the host `filesRoot` for back-compat. A `MultiRootWatcher` watches every local project root and re-subscribes as projects change, emitting `files` changes tagged with `projectId` (new optional field threaded through `VaultChange` → ws frame → web `onVaultChange`). The `/repo-file/` byte route becomes `/repo-file/<projectId>/<path>`. The web drops its single boot-time `repoFiles` list and `isHostFilesRoot` gating; the project page lists files lazily per project, and `openRepoFile(projectId, path)` carries the project through the viewer + recents + last-doc.

**Tech Stack:** TypeScript, Node (`node:fs`), vitest, pnpm workspace. Host packages: `apps/host`, `packages/host-api`. Web: `apps/web`.

**Conventions for the executor:**
- Run a single package's tests with `cd apps/host && npx vitest run <file>` (or `apps/web`). Full suite: `pnpm test` from the worktree root.
- TDD: write the failing test, see it fail, implement minimally, see it pass, commit. One logical change per commit. Never `git add .` — stage explicit paths. No Claude attribution in commit messages.
- Baseline is green at the start of this plan (commit `fc57fe3`). Keep it green after every task.
- `happy-dom`/`tmux blew up`/`NetworkError` lines in test output are intentional negative-path stderr, not failures — judge by the `Tests N passed` line.

---

## Task 1: Thread an optional `projectId` through the change feed

A `files` change must say *which* project's file changed. Add an optional field end-to-end; every existing caller stays valid (it's optional).

**Files:**
- Modify: `apps/host/src/nodeHost.ts` (the `VaultChange` interface, ~line 86)
- Modify: `apps/host/src/wsTransport.ts` (the `ServerEvent` interface, ~line 22)
- Modify: `apps/host/src/wsServer.ts` (the change-frame send, ~line 42)
- Modify: `apps/web/src/host/index.ts` (`onVaultChange` signature + ws event dispatch, lines 15-21, 75-80)
- Test: `apps/host/test/changeFeed.test.ts`

**Step 1 — Write the failing test.** In `changeFeed.test.ts`, add a case asserting a `files` change carrying `projectId` round-trips over the ws change feed. Model it on the existing test in that file (reuse its harness). Assert the received event has `projectId === "proj_x"`:

```ts
test("a files change carries its projectId over the feed", async () => {
  // ... existing harness: start ws host, connect client, collect events ...
  host.emitChange({ ns: "files", key: "docs/a.md", projectId: "proj_x" });
  const ev = await nextEvent();
  expect(ev).toMatchObject({ ns: "files", key: "docs/a.md", projectId: "proj_x" });
});
```
(Adapt to however the existing test injects a change — if it goes through `vault.set`, instead drive a real `files` change once Task 4 exists; for now use the lowest-level change emit the harness exposes. If no emit hook exists, SKIP this test here and fold the assertion into Task 4's watcher test.)

**Step 2 — Run it, expect fail** (`projectId` undefined on the event).

**Step 3 — Implement:**
- `VaultChange`: add `projectId?: string;`.
- `ServerEvent`: add `projectId?: string;`.
- `wsServer.ts`: `socket.send(JSON.stringify({ type: "change", ns: change.ns, key: change.key, projectId: change.projectId }))`.
- `host/index.ts`: change the stored `subscribe` type and `onVaultChange` to `(ns: string, key: string, projectId?: string) => void`; in the ws `subscribe`, call `cb(e.ns, e.key, e.projectId)`. Echo-suppression key stays `${ns} ${key}` (project-agnostic is fine — a repo path is unique within the open doc).

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/host/src/nodeHost.ts apps/host/src/wsTransport.ts apps/host/src/wsServer.ts apps/web/src/host/index.ts apps/host/test/changeFeed.test.ts && git commit -m "Add optional projectId to the vault change feed"`

---

## Task 2: `resolveProjectRoot` helper (vault projects → absolute root)

A single resolver both `FsFiles` and the repo-file route use. Reads the `projects` vault ns; returns the local path for a local project, the `filesRoot` alias for `"repo"`, else `undefined`.

**Files:**
- Create: `apps/host/src/projectRoots.ts`
- Test: `apps/host/test/projectRoots.test.ts`

**Step 1 — Write the failing test:**

```ts
import { describe, test, expect } from "vitest";
import { makeProjectRootResolver } from "../src/projectRoots";
import type { Host } from "@orden/host-api";

function vaultWith(recs: Record<string, unknown>): Host {
  return { vault: { get: async (_ns: string, key: string) => recs[key] ?? null } } as unknown as Host;
}

describe("makeProjectRootResolver", () => {
  const FILES_ROOT = "/srv/orden";
  test("resolves a local project to its source.path", async () => {
    const r = makeProjectRootResolver(vaultWith({
      p1: { id: "p1", name: "X", source: { kind: "local", path: "/home/u/x" } },
    }), FILES_ROOT);
    expect(await r("p1")).toBe("/home/u/x");
  });
  test("aliases the literal 'repo' id to filesRoot", async () => {
    const r = makeProjectRootResolver(vaultWith({}), FILES_ROOT);
    expect(await r("repo")).toBe(FILES_ROOT);
  });
  test("returns undefined for ephemeral / unknown / non-local", async () => {
    const r = makeProjectRootResolver(vaultWith({
      eph: { id: "eph", name: "H", source: { kind: "ephemeral" } },
    }), FILES_ROOT);
    expect(await r("eph")).toBeUndefined();
    expect(await r("nope")).toBeUndefined();
  });
  test("returns undefined for 'repo' when no filesRoot is configured", async () => {
    const r = makeProjectRootResolver(vaultWith({}), undefined);
    expect(await r("repo")).toBeUndefined();
  });
});
```

**Step 2 — Run, expect fail** (module missing).

**Step 3 — Implement `apps/host/src/projectRoots.ts`:**

```ts
// Resolve an orden projectId to the absolute filesystem root its files live
// under, reading the shared "projects" vault namespace (the same records the web
// writes). Local projects resolve to their source.path; the legacy "repo" id
// aliases the host's configured filesRoot for back-compat; everything else
// (ephemeral/ssh/s3/unknown) has no local root and resolves to undefined.
import type { Host, Project } from "@orden/host-api";

export type ProjectRootResolver = (projectId: string) => Promise<string | undefined>;

export function makeProjectRootResolver(
  host: Pick<Host, "vault">,
  filesRoot: string | undefined,
): ProjectRootResolver {
  return async (projectId: string) => {
    if (projectId === "repo") return filesRoot;
    const rec = await host.vault.get<Project>("projects", projectId);
    if (rec?.source.kind === "local") return rec.source.path;
    return undefined;
  };
}
```

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/host/src/projectRoots.ts apps/host/test/projectRoots.test.ts && git commit -m "Add project-root resolver over the projects vault"`

---

## Task 3: `FsFiles` multi-root list/read/write

Replace the single `root` with a resolver. Each method resolves the project's root, then applies the existing traversal guard rooted there. A projectId with no root → `list` returns `[]`, `read`/`write` reject.

**Files:**
- Modify: `apps/host/src/fsFiles.ts`
- Test: `apps/host/test/fsFiles.test.ts` (create if absent)

**Step 1 — Write failing tests** (use a tmp dir per root):

```ts
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsFiles } from "../src/fsFiles";

const dirs: string[] = [];
function root(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "fsroot-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("FsFiles (multi-root)", () => {
  test("lists files from the resolved per-project root", async () => {
    const a = root({ "a.md": "# A" });
    const b = root({ "b.md": "# B" });
    const fs = new FsFiles(async (id) => (id === "pa" ? a : id === "pb" ? b : undefined));
    expect((await fs.list("pa")).map((e) => e.path)).toEqual(["a.md"]);
    expect((await fs.list("pb")).map((e) => e.path)).toEqual(["b.md"]);
  });
  test("returns [] for a project with no root", async () => {
    const fs = new FsFiles(async () => undefined);
    expect(await fs.list("ghost")).toEqual([]);
  });
  test("reads/writes within the resolved root and blocks traversal", async () => {
    const a = root({ "a.md": "# A" });
    const fs = new FsFiles(async () => a);
    expect(await fs.read("pa", "a.md")).toBe("# A");
    await fs.write("pa", "sub/c.md", "hi");
    expect(await fs.read("pa", "sub/c.md")).toBe("hi");
    await expect(fs.read("pa", "../escape.md")).rejects.toThrow();
  });
  test("rejects read/write for a project with no root", async () => {
    const fs = new FsFiles(async () => undefined);
    await expect(fs.read("ghost", "a.md")).rejects.toThrow();
    await expect(fs.write("ghost", "a.md", "x")).rejects.toThrow();
  });
});
```

**Step 2 — Run, expect fail** (constructor still takes a string).

**Step 3 — Implement.** In `fsFiles.ts`:
- Change the constructor to `constructor(private readonly resolveRoot: ProjectRootResolver)` (import the type from `./projectRoots`).
- Add a private `private async rootFor(projectId: string): Promise<string>` that calls `resolveRoot` and throws `Error(\`FsFiles: no root for project ${projectId}\`)` if undefined. Keep `resolveInRoot(root, path)` but make it take the root as a parameter.
- `list(projectId)`: `const root = await this.resolveRoot(projectId); if (!root) return []; ` then walk that root (existing `walk` logic, parameterized by root).
- `read(projectId, path)`: `const root = await this.rootFor(projectId); return readFile(this.resolveInRoot(root, path), "utf8");`
- `write(projectId, path, content)`: same pattern with the existing mkdir.
- Keep `pickDirectory` (added in the WIP) unchanged.
- Move the `watch` method OUT of `FsFiles` — it now lives in `MultiRootWatcher` (Task 4). Delete the `watch` method here (Task 5 rewires the watcher; verify no remaining caller of `FsFiles.prototype.watch` first — there is exactly one, in `nodeHost.ts`).

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/host/src/fsFiles.ts apps/host/test/fsFiles.test.ts && git commit -m "FsFiles: resolve list/read/write per project root"`

---

## Task 4: `MultiRootWatcher` (dynamic, vault-driven)

Watch every local project's root; emit a `files` change tagged with that project's id on any in-root change. Re-subscribe when the `projects` vault ns changes (add/edit/remove).

**Files:**
- Create: `apps/host/src/multiRootWatcher.ts`
- Test: `apps/host/test/multiRootWatcher.test.ts`

**Step 1 — Write failing tests.** Drive it with a fake `projects` registry + real tmp dirs; assert that writing a file in a watched root yields a `(projectId, repoRelativePath)` callback, and that adding a project after start begins watching it. Use a short poll/`await delay` for the debounce (the existing watcher debounces ~120ms; allow ~300ms). Sketch:

```ts
test("emits (projectId, path) for a change under a local project's root", async () => {
  const a = root({}); // tmp dir
  const projects = [{ id: "pa", name: "A", source: { kind: "local", path: a } }];
  const seen: Array<[string, string]> = [];
  const w = new MultiRootWatcher(
    async () => projects,                       // list local projects
    (projectId, path) => seen.push([projectId, path]),
  );
  await w.start();
  writeFileSync(join(a, "x.md"), "hi");
  await delay(350);
  expect(seen).toContainEqual(["pa", "x.md"]);
  await w.stop();
});
```
Add a second test: push a new project into the array, call `w.refresh()` (the method the vault-change subscription will call), write under the new root, expect its changes now seen. Add a third: `stop()` closes all watchers (no callbacks after stop).

**Step 2 — Run, expect fail.**

**Step 3 — Implement `multiRootWatcher.ts`.** Port the per-path debounce + recursive `watch` + `SKIP_DIRS` filter + `error` swallow from the old `FsFiles.watch`. Keep a `Map<projectId, {root, watcher}>`. `start()`/`refresh()` diff the current local-project set against the map: open watchers for new/changed roots, close watchers for removed/repathed ones (close + reopen on path change). Each watcher's callback reports `(projectId, repoRelativePath)`. `stop()` closes all. Reuse `SKIP_DIRS` (export it from `fsFiles.ts` or duplicate the small set with a comment).

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/host/src/multiRootWatcher.ts apps/host/test/multiRootWatcher.test.ts && git commit -m "Add MultiRootWatcher: dynamic per-project file watching"`

---

## Task 5: Wire resolver + watcher into `NodeHost`

**Files:**
- Modify: `apps/host/src/nodeHost.ts` (FileSource construction ~145-155; add a local-projects lister)
- Test: `apps/host/test/nodeHost.test.ts`

**Step 1 — Write/adjust the failing test.** Add a `nodeHost.test.ts` case: with a `projects` vault record `{kind:"local", path:<tmp with a file>}`, `host.files.list(projectId)` returns that file; with `"repo"` it returns files under `filesRoot`. (If `nodeHost.test.ts` constructs a host without a real vault dir, use the existing harness; keep it minimal.)

**Step 2 — Run, expect fail.**

**Step 3 — Implement:**
- Build the resolver: `const resolveRoot = makeProjectRootResolver(this, opts.filesRoot);` (NodeHost exposes `vault`).
- `this.files = new FsFiles(resolveRoot);` (drop the `StubFiles` branch — `FsFiles` now degrades to empty lists when nothing resolves, so it is safe even with no `filesRoot`; `"repo"` simply resolves to `undefined` then). Keep `StubFiles` only if other capabilities (`pickDirectory`) still need it — `FsFiles.pickDirectory` already exists, so `StubFiles` can be removed. Verify no other reference to `StubFiles`.
- Replace the old `files.watch(...)` block with a `MultiRootWatcher`: construct it with a lister `async () => (await this.vault.list("projects")).map(get).filter(local)` and the callback `(projectId, path) => emit({ ns: "files", key: path, projectId })`. Call `void watcher.start()`. Subscribe to the change feed: `this.onChange((c) => { if (c.ns === "projects") void watcher.refresh(); })`.
- Keep `capabilities().filesRoot` as-is (still meaningful: the agent/session default cwd + the `"repo"` alias).

**Step 4 — Run, expect pass** (`cd apps/host && npx vitest run test/nodeHost.test.ts`). Then run the whole host suite: `cd apps/host && npx vitest run`.

**Step 5 — Commit:** `git add apps/host/src/nodeHost.ts apps/host/test/nodeHost.test.ts && git commit -m "NodeHost: per-project FsFiles + MultiRootWatcher"`

---

## Task 6: `/repo-file/<projectId>/<path>` byte route

**Files:**
- Modify: `apps/host/src/repoFileRoute.ts`
- Modify: `apps/host/src/serve.ts` (pass the resolver to the handler, ~line 136)
- Test: `apps/host/test/repoFileRoute.test.ts`

**Step 1 — Write failing tests.** Update existing tests: the URL is now `/repo-file/<projectId>/<rel>`. `resolveRepoFile` becomes async (it must resolve the project root). Add: a known project id resolves bytes; an unknown project id → null (403); traversal still blocked.

```ts
const resolve = async (id: string) => (id === "pa" ? ROOT : undefined);
expect(await resolveRepoFile(resolve, "/repo-file/pa/img.png")).toBe(join(ROOT, "img.png"));
expect(await resolveRepoFile(resolve, "/repo-file/ghost/img.png")).toBeNull();
expect(await resolveRepoFile(resolve, "/repo-file/pa/../escape")).toBeNull();
```

**Step 2 — Run, expect fail.**

**Step 3 — Implement.** `resolveRepoFile(resolve: ProjectRootResolver, url)`: strip the prefix, split off the FIRST path segment as `projectId`, decode the remainder as the repo-relative path, `const root = await resolve(projectId); if (!root) return null;` then the existing join/`relative` traversal guard against `root`. `handleRepoFileRequest(resolve, req, res)` becomes async accordingly. In `serve.ts`, build `const resolveRoot = makeProjectRootResolver(host, filesRoot);` once and pass it: `void handleRepoFileRequest(resolveRoot, req, res);`.

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/host/src/repoFileRoute.ts apps/host/src/serve.ts apps/host/test/repoFileRoute.test.ts && git commit -m "Serve /repo-file/<projectId>/<path> per project root"`

---

## Task 7: Recent-files store carries projectId

**Files:**
- Modify: `apps/web/src/recentFiles.ts`
- Test: `apps/web/test/recentFiles.test.ts` (create if absent)

**Step 1 — Write failing tests.** Entries become `{ projectId: string; path: string }`. De-dup is by `projectId+path`. `recordRecentFile(projectId, path)` moves to front; `listRecentFiles(cap)` returns entries newest-first. Add a migration test: a legacy persisted `string[]` hydrates as `{projectId:"repo", path}` entries (back-compat for already-stored recents).

**Step 2 — Run, expect fail.**

**Step 3 — Implement.** Change `cache` to `Array<{projectId:string;path:string}>`. `hydrateRecentFiles`: if stored items are strings, map to `{projectId:"repo", path}`. `recordRecentFile(projectId, path)`: dedup by both fields. `listRecentFiles` returns the objects. Update `SHOW_CAP`/`STORE_CAP` unchanged.

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/web/src/recentFiles.ts apps/web/test/recentFiles.test.ts && git commit -m "recentFiles: track {projectId, path} with legacy migration"`

---

## Task 8: `repoFileUrl(projectId, path)`

**Files:**
- Modify: `apps/web/src/richView.ts` (the `repoFileUrl` helper, ~line 8; its caller ~line 16)
- Test: `apps/web/test/richView.test.ts` (create if absent — a 2-line URL-shape test)

**Step 1 — Failing test:** `expect(repoFileUrl("pa", "a/b c.png")).toBe("/repo-file/pa/a/b%20c.png")`.

**Step 2 — Run, expect fail.**

**Step 3 — Implement:** `export function repoFileUrl(projectId: string, path: string) { return \`/repo-file/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}\`; }`. Update the image renderer to take/forward a projectId (its caller is the image view in `main.ts`, wired in Task 9).

**Step 4 — Run, expect pass.**

**Step 5 — Commit:** `git add apps/web/src/richView.ts apps/web/test/richView.test.ts && git commit -m "repoFileUrl: include projectId in the byte-route URL"`

---

## Task 9: `main.ts` — project-scoped open/viewer/boot

The behavioral core. No new unit test (this is wiring over DOM singletons); guard with `tsc`/build + the existing suite, and a manual smoke in Task 12's verification. Make these edits in `apps/web/src/main.ts`:

**Files:** Modify `apps/web/src/main.ts`; Modify `apps/web/src/projectPage.ts` (signature, Task 10).

1. **Delete** the boot-time `const repoFiles = await host.files.list("repo");` (~965) and the `isHostFilesRoot` import + its use in `renderProject` (~17, ~732-733). `renderProject` passes the project through; the page fetches its own files (Task 10).
2. Add module state: `let currentDocProjectId = "repo";` next to `currentDocKey` (~139).
3. **`openRepoFile`** → `openRepoFile(projectId: string, path: string)`:
   - `currentDocProjectId = projectId;`
   - every `host.files.read("repo", path)` → `host.files.read(projectId, path)` (4 sites here + 3 in the change handler).
   - title: drop the `repoFiles.find(...)`; use `path.split("/").pop()` (the project page already has titles; the viewer title from filename is fine). If a title is wanted, read it lazily — but YAGNI: filename is acceptable.
   - image view: pass `projectId` so `renderImageView` builds `repoFileUrl(projectId, path)`.
   - `recordRecentFile(projectId, path)` (Task 7 signature).
   - `last-doc` persistence: store `{ projectId, path }` (JSON) instead of the `review:<path>` string. Update the reader (below).
4. **Boot:** replace the last-opened/design/first-file block (~1064-1079) with: always `loadReviewDoc({ key: "review:sample", title: DOC_TITLE, markdown: sampleMarkdown, seedIfEmpty: true });`. Delete the `repoFiles.find(...)` default-file logic. (Decision: boot shows the sample; files open from a project page.)
5. **`files` change handler** (~1293): the handler now receives `(ns, key, projectId)`. Match on `currentDocProjectId === projectId && currentDocKey === \`review:${key}\``; reads use `host.files.read(projectId, key)`; image re-render uses `repoFileUrl(projectId, key)`.
6. **`onVaultChange`** callback gains the third arg `(ns, key, projectId)` (Task 1).
7. The htmlToggle re-open (~1028) and any other `openRepoFile(path)` callers now pass `currentDocProjectId`.

**Step — Verify:** `cd apps/web && npx tsc --noEmit` (or the project's typecheck script) and `npx vitest run`. Expected: compiles, suite green.

**Commit:** `git add apps/web/src/main.ts && git commit -m "main: open repo files per project; sample doc on boot"`

---

## Task 10: `projectPage.ts` — lazy per-project file list

**Files:**
- Modify: `apps/web/src/projectPage.ts`
- Modify: `apps/web/src/main.ts` (the `renderProjectPage` call site, Task 9 already touched it)

**Step 1 — Implement.** `renderProjectPage`'s `repoFiles` param and the `onOpenFile(path)` callback change:
- Drop the `repoFiles: FileEntry[]` parameter. Instead the page fetches files itself: when `project.source.kind === "local"`, call `host.files.list(projectId)` and render the Files widget from the result (async — render a "Loading…"/empty state first, then populate). The page already imports nothing from the host; pass a `listFiles: (projectId) => Promise<FileEntry[]>` callback from `main.ts` (keep `projectPage` host-agnostic, matching its current style of injected callbacks).
- `onOpenFile` becomes `(projectId, path)` OR the page closes over its `projectId` and calls `onOpenFile(projectId, path)`. In `main.ts`, wire `(path) => void openRepoFile(projectId, path)`.
- Delete the `isHostFilesRoot`-gated empty list; the widget now reflects the project's own files (empty for ephemeral/ssh/s3, which already omit the widget via the `source.kind === "local"` guard at ~153).

**Step 2 — Verify:** `cd apps/web && npx vitest run` + typecheck. The existing project-page tests (if any) still pass; adjust the call site.

**Step 3 — Commit:** `git add apps/web/src/projectPage.ts apps/web/src/main.ts && git commit -m "projectPage: list files lazily per project, drop single-root gating"`

---

## Task 11: Nav "Files" → closed-by-default "Recent files"

**Files:**
- Modify: `apps/web/index.html` (the nav section, lines 18-21)
- Modify: `apps/web/src/main.ts` (`renderRecentFiles`, ~1036, to render `{projectId, path}` and open with both)
- Modify: `apps/web/src/styles.css` (a small rule for the collapsible nav section if needed)

**Step 1 — Implement.**
- `index.html`: wrap the Files section in a `<details class="nav-section nav-files">` with `<summary class="nav-section-title">Recent files</summary>` and the `#recent-list` inside. Closed by default (no `open` attribute).
- `renderRecentFiles`: iterate `listRecentFiles(SHOW_CAP)` objects; each row's click calls `openRepoFile(entry.projectId, entry.path)`. Show the filename (`entry.path.split("/").pop()`); the meta line can show the dir or the project name.
- `styles.css`: ensure the `<summary>` matches the existing `.nav-section-title` look and shows a disclosure affordance; collapse spacing as needed.

**Step 2 — Verify:** build the web app (`npm run build --prefix apps/web` per the repo's serve-from-dist note) and confirm typecheck + suite green.

**Step 3 — Commit:** `git add apps/web/index.html apps/web/src/main.ts apps/web/src/styles.css && git commit -m "Nav: furl Files into a closed-by-default Recent files section"`

---

## Task 12: BrowserHost + full-suite + manual verification

**Files:**
- Modify: `apps/web/src/host/browserHost.ts` (keep it honest: `list(projectId)` may keep returning its inlined repo docs for any id, or `[]` for non-"repo"/"orden" ids — minimal; it has no real fs. Leave a comment that multi-root is a NodeHost-only capability.)
- Test: full suite.

**Step 1 — Full suite:** from the worktree root, `pnpm test`. Expected: every package green (host + web). Fix any fallout (call sites still passing `"repo"`, type errors from the new signatures).

**Step 2 — Manual smoke (REQUIRED SUB-SKILL: superpowers:verification-before-completion, and the `verify`/`run` skills):**
- Build web to dist, run the host via tsx (per the "Run orden locally" memory), open the app.
- Open the **ygqc** project page → its files from `/home/b/projects/ygqc` now list; open one → it renders.
- Open the **Orden** project page → its files still list (via the `"repo"`/local-path resolution).
- Confirm the nav shows a closed "Recent files"; opening a file adds it; reopening from there works and lands in the right project.
- Edit a file in ygqc on disk → the open doc live-reloads (multi-root watcher + projectId-tagged change).
- Confirm boot shows the sample doc (no auto-opened repo file).

**Step 3 — Commit any fixes**, then STOP for review. Do not merge — hand back to the user (superpowers:finishing-a-development-branch).

---

## Out of scope / deferred

- ssh/s3 project file access (still no local root — empty lists, by design).
- Per-project working-dir for agent sessions beyond what the WIP already added.
- Titling recent/viewer entries from file H1 (filename is used; revisit if wanted).
