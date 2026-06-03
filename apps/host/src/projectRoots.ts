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
