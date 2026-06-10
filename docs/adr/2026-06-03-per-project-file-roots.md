# ADR-0013: Per-project file roots with multi-root watching

**Date:** 2026-06-03
**Status:** accepted

## Context

Originally `FsFiles` was rooted at a single host-wide `filesRoot`, meaning only
the one project whose path matched `filesRoot` (the repo) could list and open
files. Every other local project showed an empty file list. This broke the
multi-project design: orden must serve files from any local project, and file
changes in any watched project must live-reload the open viewer.

## Discussed in

Conversation `604e10f0-5465-44b6-83d2-1ad409384cbe` (2026-06-03):

> "Files are shown across project rather than just within their project root.
> This is occurring on the project pages. For example the files for Orden are
> showing in the ygqc project inappropriately."

In the follow-up `d00db384-f2ee-4158-8963-8fc6ce0ca5a5`, after a fix that broke
file visibility for ygqc, the user also decided:

> "I think we want to remove files from the nav. I am not finding it helpful.
> Perhaps we can furl/close it under 'recent files' instead of showing it."

This drove the nav change from a flat Files list to a closed-by-default "Recent
files" section.

## Decision

**Make `FsFiles` resolve files per project, backed by vault project records.
Introduce a `MultiRootWatcher` that dynamically watches every local project
root and re-subscribes as projects change. Thread `projectId` through the
change feed so file-change events tag their originating project.**

- `FsFiles` constructor takes a `ProjectRootResolver` (`(projectId) =>
  Promise<string | undefined>`) instead of a single `root` string. Each
  `list`/`read`/`write` call resolves the project's root first.
- `makeProjectRootResolver(host, filesRoot)`: reads the shared `projects`
  vault namespace; returns `source.path` for local projects, `filesRoot` for
  the `"repo"` alias, `undefined` for ephemeral/ssh/s3/unknown.
- `MultiRootWatcher`: watches every local project root. Diff-watches the project
  set on vault change: opens watchers for new/changed roots, closes for removed
  ones. Each callback reports `(projectId, repoRelativePath)`.
- `VaultChange` and the WebSocket event frame gain an optional `projectId`
  field. The web's `onVaultChange` handler matches on `currentDocProjectId` to
  live-reload only the open doc belonging to the changed project.
- The `/repo-file/` byte route becomes `/repo-file/<projectId>/<path>`,
  resolving the project's root per call.
- The web drops its boot-time single `repoFiles` list. The project page fetches
  its own files lazily via `host.files.list(projectId)`. The nav "Files" section
  becomes a closed-by-default "Recent files" list tracking `{projectId, path}`.

**Rejected alternatives:**

- **One watcher per project, manually managed.** The dynamic set-diff approach in
  `MultiRootWatcher` handles add/remove/re-path without manual lifecycle
  management.
- **Vault change channel for project adds/removes separate from MultiRootWatcher.**
  The watcher already diffs the project set; subscribing to vault changes for
  `refresh()` keeps it self-contained without a separate notification path.

## Consequences

**Easier:**

- Any local project added in the UI immediately shows its files and gets watched
  for live-reload — no restart, no separate configuration.
- `"repo"` alias preserves backward compatibility for the repository-root
  project without special-casing.
- Project pages show only their own files, not a global list.

**Harder:**

- The `projectId` thread must be carried through every layer: VaultChange →
  wsTransport → wsServer → client → web handler. Omitting it anywhere means file
  changes from the wrong project could trigger a false live-reload.
- `MultiRootWatcher` holds `fs.watch` handles per project root — must be cleaned
  up on project removal to avoid handle leaks.
- The `"repo"` alias resolution depends on `filesRoot` being configured; without
  it, `"repo"` resolves to `undefined` and shows no files.
