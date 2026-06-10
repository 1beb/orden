// Exposes the orden repo's own markdown docs as openable files, so the project
// can be reviewed inside orden itself. Vite inlines the content at build time
// via import.meta.glob (eager + ?raw); server.fs.allow grants access to the repo
// root (see vite.config.ts).

export interface RepoFile {
  path: string; // repo-relative, e.g. "docs/plans/2026-05-28-orden-design.md"
  title: string;
  content: string;
}

const globbed = {
  ...import.meta.glob("../../../docs/**/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../.claude/skills/**/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../.opencode/skills/**/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

function repoPath(globKey: string): string {
  // glob keys look like "../../../docs/plans/foo.md" → "docs/plans/foo.md"
  return globKey.replace(/^(\.\.\/)+/, "");
}

function titleOf(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.split("/").pop() ?? path;
}

const files: RepoFile[] = Object.entries(globbed)
  .map(([key, content]) => {
    const path = repoPath(key);
    return { path, title: titleOf(content, path), content };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

export function listFiles(): RepoFile[] {
  return files;
}

export function getFile(path: string): RepoFile | undefined {
  return files.find((f) => f.path === path);
}
