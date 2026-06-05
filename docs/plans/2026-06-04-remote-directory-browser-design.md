# Remote directory browser for the project modal

## Problem

The "Browse…" button in the add/edit-project modal calls `host.files.pickDirectory()`,
which on a NodeHost spawns a native `zenity`/`kdialog` dialog on the host machine's
own display (`apps/host/src/pickDirectory.ts`). When the web app is loaded from a
remote/mobile client (the `VITE_ORDEN_HOST=auto` → `wss://<host>` path), the host
still reports the `pickDirectory` capability as true (it only checks whether a picker
tool is installed), so the button renders — but clicking it pops a dialog on the
workstation's physical screen, invisible and unusable to the phone. The promise hangs
until the 5-minute timeout, then returns `null`. Nothing happens on the phone.

This is the hazard the code itself flagged: *"the dialog opens on the HOST machine's
display … a remote host would pop the dialog on the server, which is nonsensical —
gate accordingly when remote hosts land."* Remote hosts landed; the gate did not.

Root cause: the `pickDirectory` capability conflates *"the host has a picker tool"*
with *"this user can see it,"* which is false for any remote client.

## Why not the browser's native picker

`<input webkitdirectory>` and `showDirectoryPicker()` both pick a folder on the
*client device* (the phone), not the host, and browsers deliberately hide the real
absolute path. They are rooted in the wrong machine. zenity = right machine, wrong
screen; native browser picker = right screen, wrong machine. Only a custom
data-on-host / render-in-client split can show the host's filesystem on the phone.

## Decisions

- Replace the native picker **everywhere** (local and remote) with one in-app
  directory browser. Delete the zenity/kdialog path entirely — one code path, no
  native dependency, works headless / over SSH / on mobile, fully testable.
- **Full filesystem reach**, opening at `$HOME` (or the current path field if set);
  navigate up to `/`. A connected client can already spawn host shell sessions, so
  directory listing exposes nothing new.
- **Breadcrumb + folder-list UI**: current path label, `..` row, tap a folder to
  descend, a `Select this folder` button to pick the current directory.

## Architecture: data on host, rendering in client

The host owns the data (`listDir`); the one web build owns the rendering. The same
bundle serves desktop and mobile identically — there is no mobile-specific code. The
generic RPC proxy (`apps/host/src/rpc.ts`) forwards any new `files` method over WS,
so no transport/wsServer changes are needed.

### Data contract (`packages/host-api`)

```ts
export interface DirEntry {
  name: string;            // basename, e.g. "orden"
  path: string;            // absolute, e.g. "/home/b/projects/orden"
}

export interface DirListing {
  path: string;            // absolute, normalized current dir
  parent: string | null;   // absolute parent, or null at filesystem root "/"
  entries: DirEntry[];     // immediate sub-directories only, sorted name-ascending
}

// On FileSource — standalone, NOT project-rooted:
listDir(path?: string): Promise<DirListing>; // omitted/empty -> $HOME
```

Capability `pickDirectory: boolean` → `browseDirectories: boolean`. True on any host
with a real filesystem (nodeHost always); absent on browserHost.

### Host implementation (`apps/host/src/fsFiles.ts`)

```ts
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

- `dirname("/") === "/"`, so `parent === dir` yields `null` exactly at the fs root.
- Directories only (files are noise for a folder picker); dotfiles + `SKIP_DIRS`
  (`node_modules`, `.git`, `dist`, …) filtered for a tidy project picker; sorted
  alphabetically because `readdir` order is filesystem/inode order.
- Errors are real: `readdir` rejects on ENOENT/EACCES/ENOTDIR; `dispatch` already
  wraps that to `{ok:false,error}` for the client. Deliberately unlike the old
  `pickDirectory`, whose silent `null` made this very bug invisible.

`browserHost` `LocalFiles.listDir` throws `"BrowserHost: no filesystem"` — never
called, since `browseDirectories` is absent there and the button never renders.

### Web list view (`apps/web/src/directoryBrowser.ts`)

Vanilla DOM, matching `projectModal.ts`. One export:

```ts
// Sub-overlay above the project modal; resolves to the chosen absolute path,
// or null if dismissed. startPath seeds the first listDir call.
export function browseForDirectory(startPath?: string): Promise<string | null>;
```

- `.preview-overlay` / `.preview-modal` shell, layered above the still-open project
  form.
- Header: current absolute path + `✕`.
- List: `..` row first (omitted when `parent === null`), then one button per entry
  (`name/` with a `›`). Tapping a folder re-lists via `listDir(entry.path)`; tapping
  `..` re-lists `parent`.
- Footer: `Select this folder` resolves with `listing.path` (the current dir), so you
  can pick without descending — like native pickers.
- State is just `currentListing`; each navigation is a fresh round-trip (no caching).
  In-flight RPC disables the list; an error renders inline, leaving the prior listing
  intact so an unreadable dir doesn't trap you. Rows rebuilt with `replaceChildren`.

### Modal integration (`apps/web/src/projectModal.ts`)

Only the Browse handler changes: `canPickDirectory()` → `canBrowseDirectories()`, and
the click calls `browseForDirectory(pathInput.value.trim() || undefined)`, writing the
result into `pathInput` and dispatching `input` (keeps the working-dir placeholder in
sync). The text input stays the source of truth — typing a path still works.

## Removals / renames

- Delete `apps/host/src/pickDirectory.ts` (and its test).
- `FileSource`: remove `pickDirectory`, add `listDir`; update both host impls.
- Capability `pickDirectory` → `browseDirectories` (nodeHost `true`, browserHost
  omits).
- `apps/web/src/projects.ts`: `canPickDirectory`/`pickDirectory` →
  `canBrowseDirectories` (the `listDir` call lives in `directoryBrowser.ts`).
- Update tests referencing old names (`selectHost.test`, `projects.test`, host
  `pickDirectory` test).

## Testing

- Host `listDir` (`fsFiles` test): temp tree with sub-dirs + dotdir + `node_modules`
  + a file → only visible sub-dirs, sorted; `parent` correct mid-tree and `null` at
  `/`; bad path rejects.
- RPC pass-through: `listDir` round-trips through `connectHostClient`/`dispatch`.
- Web `directoryBrowser` (jsdom): fake `host.files.listDir` → `..` hidden at root;
  descending re-lists; `Select this folder` resolves the current `path`; an error
  listing renders inline without clearing the view.
- browserHost: `browseDirectories` absent → Browse button never renders.

Error contract end to end: `listDir` rejects → `dispatch` wraps to `{ok:false}` → the
navigator shows it inline. The only `null` is user dismissal. No silent nulls — the
original invisible-failure mode is closed.
