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
    // Host root: open/edit/annotate an arbitrary absolute path the user (or an
    // agent on their behalf) referenced, WITHOUT it belonging to a project. The
    // root is "/", so join("/", "/abs/path") === "/abs/path" and the traversal
    // guard (relative("/", full) never starts with "..") admits any absolute
    // path. This is a deliberate single-user escape hatch from the per-project
    // file model (ADR-0013): these files are never listed, watched, or fed to
    // omnisearch — only resolved on demand for a direct open. The byte route and
    // FsFiles share this resolver, so read + write + annotate all work.
    if (projectId === "host") return "/";
    // Session-scoped root: a session running in its own git worktree exposes
    // that worktree as a file root. The repo-file route, FsFiles, and
    // Host.render all resolve through here, so panel_open / doc_render work on
    // worktree paths with no other plumbing.
    if (projectId.startsWith("session:")) {
      const rec = await host.vault.get<{ workdir?: string }>("sessions", projectId.slice(8));
      return typeof rec?.workdir === "string" && rec.workdir ? rec.workdir : undefined;
    }
    const rec = await host.vault.get<Project>("projects", projectId);
    if (rec?.source.kind === "local") return rec.source.path;
    return undefined;
  };
}

// Enumerate every local project's id + absolute filesystem root from the
// "projects" vault ns. Same "local project → source.path" rule as the resolver
// above, but for the whole set at once (the watcher needs the full root list).
export async function listLocalProjectRoots(
  host: Pick<Host, "vault">,
): Promise<Array<{ id: string; root: string }>> {
  const ids = await host.vault.list("projects");
  const recs = await Promise.all(ids.map((id) => host.vault.get<Project>("projects", id)));
  return recs.flatMap((p) =>
    p && p.source.kind === "local" ? [{ id: p.id, root: p.source.path }] : [],
  );
}
