// A folder tree built from a flat list of repo-relative file paths (the shape
// the host's FileSource.list returns). Pure and DOM-free so it's unit-testable;
// the project page renders the result into collapsible <details> rows.

export interface FileTreeNode {
  // Display label. For a compacted single-child folder chain this is the joined
  // segment run, e.g. "apps/web/src".
  name: string;
  // Full repo-relative path. For files it's the file path; for folders it's the
  // path to the folder (its deepest segment when compacted) — used as a stable
  // key for expand/collapse state across the page's frequent re-renders.
  path: string;
  isDir: boolean;
  // Folders only; files carry an empty array.
  children: FileTreeNode[];
}

interface DirBuilder {
  dirs: Map<string, DirBuilder>;
  files: string[]; // leaf segment names
  path: string; // path to this dir ("" at root)
}

function newDir(path: string): DirBuilder {
  return { dirs: new Map(), files: [], path };
}

// Insert one path's segments into the builder tree.
function insert(root: DirBuilder, path: string): void {
  const segs = path.split("/");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    let next = cur.dirs.get(seg);
    if (!next) {
      next = newDir(cur.path ? `${cur.path}/${seg}` : seg);
      cur.dirs.set(seg, next);
    }
    cur = next;
  }
  cur.files.push(segs[segs.length - 1]);
}

// Convert a builder dir to output nodes, compacting any folder whose only child
// is a single subfolder (and no files) into a combined "a/b/c" row, and sorting
// directories before files, alphabetically within each group.
function emit(dir: DirBuilder): FileTreeNode[] {
  const dirNodes: FileTreeNode[] = [];
  for (const [name, child] of dir.dirs) {
    dirNodes.push(compact(name, child));
  }
  dirNodes.sort((a, b) => a.name.localeCompare(b.name));

  const fileNodes: FileTreeNode[] = dir.files
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      path: dir.path ? `${dir.path}/${name}` : name,
      isDir: false,
      children: [],
    }));

  return [...dirNodes, ...fileNodes];
}

// Build a folder node, merging single-child folder chains. `label` is the run of
// segments accumulated so far (e.g. "apps/web").
function compact(label: string, dir: DirBuilder): FileTreeNode {
  if (dir.files.length === 0 && dir.dirs.size === 1) {
    const [childName, child] = [...dir.dirs.entries()][0];
    return compact(`${label}/${childName}`, child);
  }
  return { name: label, path: dir.path, isDir: true, children: emit(dir) };
}

// True when `path` matches a free-text query: every whitespace-separated word
// must appear (case-insensitively) somewhere in the path. An empty query matches
// everything. Word order is irrelevant — "web cards" and "cards web" both match.
export function matchesSearch(path: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = path.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root = newDir("");
  for (const p of paths) insert(root, p);
  return emit(root);
}
