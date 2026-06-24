import { isExpiredComplete, type SessionState } from "@orden/host-api";
import type { FileEntry } from "@orden/host-api";
import {
  itemsByProject,
  addItem,
  type Item,
} from "./cards";
import {
  getProject,
  updateProject,
  type Project,
} from "./projects";
import { agentLauncher } from "./agentMarks";
import { splitThought, type ThoughtSplit } from "./thoughtSplit";
import { openNewCardModal } from "./newCardModal";
import { loadSettings } from "./settings";
import { type Agent } from "./sessions";
import { renderIssueGroups } from "./issueList";
import { buildFileTree, matchesSearch, type FileTreeNode } from "./fileTree";

// The project page surfaces what needs attention first, so it uses its own
// group order (blocked → in-progress → planning → on-hold → complete) rather
// than the board's lifecycle order. on-hold (manually parked, "come back to
// this") sits just above complete: deprioritized like done work, but still
// shown so parked cards stay findable here, not only on the board.
const STATES: SessionState[] = [
  "blocked",
  "in-progress",
  "planning",
  "on-hold",
  "complete",
];

// The container the page is mounted in, captured each render so focus guards
// can scope themselves to "is the user typing somewhere on this page".
let pageContainer: HTMLElement | null = null;

// One-shot timer that re-renders the items list the moment the soonest completed
// item crosses its TTL and falls off. Module-scoped so it survives re-renders.
let dropTimer: ReturnType<typeof setTimeout> | undefined;

// The add-item box of the currently rendered page, captured so a global
// shortcut (pressing "c" while on a project page) can focus it from outside
// this module. Reassigned each render; reads guard on isConnected.
let addInput: HTMLInputElement | null = null;

// Focus the add-item box and flash it so the jump is visible. No-op when the
// page isn't currently rendered (input detached). The flash class is removed on
// animationend so a repeated press can re-trigger it; the reflow read restarts
// the keyframe even if the class is somehow still attached.
export function focusProjectAddItem(): void {
  const input = addInput;
  if (!input?.isConnected) return;
  input.focus();
  input.classList.remove("project-add-input--flash");
  void input.offsetWidth; // force reflow so re-adding the class restarts the animation
  input.classList.add("project-add-input--flash");
}

// True while focus is in an editable control on the page (the add-item box, a
// state/project picker). A live card transition rebuilds the whole page, so
// callers skip the rebuild when this is set or they'd wipe what's being typed.
export function projectPageHasFocus(): boolean {
  const el = document.activeElement;
  if (!el || !pageContainer?.contains(el)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Project mission-control page: a single stacked column of widgets —
// Items by state (the issue tracker) and for local projects, a Files explorer.
export function renderProjectPage(
  container: HTMLElement,
  projectId: string,
  onChange: () => void,
  // The callbacks below are optional in spirit (each use is guarded in the body
  // / by the sole caller), but typed `T | undefined` rather than `?` so the
  // now-required `listFiles` can follow them without tripping TS's rule that a
  // required parameter can't come after an optional one. The only caller
  // (main.ts renderProject) always passes all of them positionally.
  // Start an agent session from an existing card that has no conversation yet.
  onStartSession: ((item: Item, agent: Agent) => void) | undefined,
  // Open an existing session in the sessions panel.
  onOpenSession: ((id: string) => void) | undefined,
  // Start a NEW project-scoped session (not tied to any card).
  onNewSession: ((agent: Agent) => void) | undefined,
  // Open a repo file in the review/document view (file-backed projects only).
  onOpenFile: ((path: string) => void) | undefined,
  // Open a card's associated document in the main panel (card modal Documents
  // list). Distinct from onOpenFile: the doc's root may be a session worktree
  // ("session:<id>") or the host root, not this project, so it carries projectId.
  onOpenDoc: ((path: string, projectId: string) => void) | undefined,
  // Fetch THIS project's own files (path + title), lazily on render. The host
  // serves files per project now, so the page asks for its own list rather than
  // receiving one global repo array. Required: the Files widget is its whole
  // reason to exist and the sole caller always passes it.
  listFiles: (projectId: string) => Promise<FileEntry[]>,
  // Open the project-settings overlay (edit details + danger-zone removal). The
  // caller owns the overlay; the page's cog just asks for it. Editing and
  // removal moved off the page into that overlay, mirroring the app-settings cog.
  onOpenSettings?: () => void,
): void {
  const project = getProject(projectId);
  pageContainer = container;
  container.replaceChildren();
  if (!project) {
    const p = document.createElement("p");
    p.className = "pages-empty";
    p.textContent = "Project not found.";
    container.append(p);
    return;
  }

  // Title row + a settings cog. The cog opens the project-settings overlay
  // (edit details + danger-zone removal), mirroring the app-settings cog.
  const header = projectHeader(project, onOpenSettings);

  // Items by state now folds the active sessions in: each row carries its
  // linked session(s) as a leading brand-mark button (open directly), so there's
  // no separate Active-sessions widget to keep in sync.
  const items = itemsWidget(projectId, onChange, onStartSession, onOpenSession, onOpenDoc);
  // A single bar at the very top: type a title and either Add it, or hit a
  // Claude / opencode mark to add the item AND start a session on it at once.
  const top = addBar(projectId, onChange, items.render, onStartSession);
  // onNewSession (a cardless project-scoped session) no longer has a launcher —
  // add+start covers session creation from the page now.
  void onNewSession;
  container.append(
    header,
    top,
    items.section,
    // File explorer last — only for file-backed (local) projects.
    // Ephemeral/ssh/s3 projects have no browsable local files, so it's omitted.
    ...(project.source.kind === "local"
      ? [
          filesWidget(projectId, listFiles, onOpenFile),
          ...FILE_CATEGORIES.map(({ title, match }) =>
            filesCategoryWidget(title, match, projectId, listFiles, onOpenFile),
          ),
        ]
      : []),
  );
}

// --- Header: title + settings cog -----------------------------------------

// The source subtitle: the path for local projects, the source kind for remote
// ones. Ephemeral projects (e.g. Homeroom) show none — "ephemeral" is an
// implementation detail, not something to surface.
function projectMetaText(project: Project): string {
  if (project.source.kind === "local") return project.source.path;
  if (project.source.kind === "ephemeral") return "";
  return project.source.kind;
}

function projectHeader(project: Project, onOpenSettings?: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "project-header";

  const titleRow = document.createElement("div");
  titleRow.className = "project-title-row";

  const heading = document.createElement("h1");
  heading.className = "project-title";
  heading.textContent = project.name;

  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = projectMetaText(project);
  meta.hidden = !meta.textContent;

  // The cog opens the project-settings overlay (edit details + removal),
  // mirroring how the app-settings cog opens the Settings view.
  const cog = document.createElement("button");
  cog.type = "button";
  cog.className = "project-cog";
  cog.title = "Project settings";
  cog.setAttribute("aria-label", "Project settings");
  cog.textContent = "⚙";
  cog.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpenSettings?.();
  });

  const cogWrap = document.createElement("div");
  cogWrap.className = "project-cog-wrap";
  cogWrap.append(cog);
  titleRow.append(heading, cogWrap);
  wrap.append(titleRow, meta);
  return wrap;
}

// --- Top bar: add an item, or add + start a session on it -----------------

function addBar(
  projectId: string,
  onChange: () => void,
  refreshItems: () => void,
  onStartSession?: (item: Item, agent: Agent) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "project-add project-add-top";
  const input = document.createElement("input");
  input.className = "project-add-input";
  input.placeholder = "Add an item…";
  // Expose this render's input to the "c" shortcut, and self-clean the flash
  // class when its animation ends so a later press can re-trigger it.
  addInput = input;
  input.addEventListener("animationend", () => {
    input.classList.remove("project-add-input--flash");
  });
  const addBtn = document.createElement("button");
  addBtn.className = "project-add-btn";
  addBtn.textContent = "Add";

  // A thought that crossed its first sentence graduates to the new-card modal:
  // the split (first sentence → title, rest → description) shows pre-filled so
  // it can be corrected, and the cursor continues in the description. Dismissal
  // hands the text back to the input, so a misfire costs nothing.
  const graduate = (split: ThoughtSplit): void => {
    input.value = "";
    openNewCardModal(
      { projectId, ...split },
      {
        onStartSession: (item, agent) => {
          onStartSession?.(item, agent);
          refreshItems();
        },
        onChange: () => {
          onChange();
          refreshItems();
        },
        onDismiss: (text) => {
          input.value = text;
          input.focus();
        },
        anchor: input,
      },
    );
  };

  // Create the card from the typed title and refresh the Items list. Returns the
  // new item so the launch buttons can immediately start a session on it. Multi-
  // sentence text (e.g. pasted, so the input listener's modal is already up — or
  // submitted straight away) routes through the modal instead.
  const create = (): Item | null => {
    const title = input.value.trim();
    if (!title) return null;
    const split = splitThought(input.value);
    if (split) {
      graduate(split);
      return null;
    }
    const item = addItem(projectId, title);
    input.value = "";
    onChange();
    refreshItems();
    return item;
  };

  input.addEventListener("input", () => {
    const split = splitThought(input.value);
    if (split) graduate(split);
  });
  addBtn.addEventListener("click", () => create());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") create();
  });
  row.append(input, addBtn);

  // The brand marks add the item and start a session on it in one action. The
  // project's default agent (if set) is emphasized in the launcher.
  if (onStartSession) {
    row.append(
      agentLauncher((agent) => {
        const item = create();
        if (!item) return;
        onStartSession(item, agent);
        refreshItems(); // show the new item's open button
      }, getProject(projectId)?.defaultAgent),
    );
  }
  return row;
}

// --- Files (file-backed projects only) ------------------------------------

// The file explorer lists every repo file, filtered along two axes: a coarse
// category (Docs / Code / Config / Other) chosen by chip, and a fine extension
// chosen by dropdown. Categories group related extensions so the common case
// ("show me the docs") is one click; the dropdown narrows to a single type.
type FileCategory = "docs" | "code" | "config" | "other";

const CATEGORY_LABELS: Record<FileCategory, string> = {
  docs: "Docs",
  code: "Code",
  config: "Config",
  other: "Other",
};
const CATEGORY_ORDER: FileCategory[] = ["docs", "code", "config", "other"];

// Extension → category. Anything unmapped falls to "Other", so the list never
// hides a file just because its type is unrecognized.
const EXT_CATEGORY: Record<string, FileCategory> = {
  md: "docs", markdown: "docs", mdx: "docs", txt: "docs", rst: "docs", adoc: "docs",
  // HTML is often prose-with-markup, so it lives with Docs for now (it's still
  // rendered as code when opened — see the document view's code/markdown split).
  html: "docs", htm: "docs",
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", rs: "code", go: "code", rb: "code", java: "code", c: "code", h: "code",
  cpp: "code", hpp: "code", cs: "code", sh: "code", sql: "code", vue: "code",
  svelte: "code", css: "code", scss: "code", less: "code",
  json: "config", yaml: "config", yml: "config", toml: "config", ini: "config",
  env: "config", lock: "config", xml: "config", conf: "config", cfg: "config",
};

// Lowercased extension after the final dot in the filename, or "" when none.
function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
function categoryOf(path: string): FileCategory {
  return EXT_CATEGORY[extOf(path)] ?? "other";
}

// Total files beneath a tree node (the count shown on a folder's summary row).
function countFiles(node: FileTreeNode): number {
  if (!node.isDir) return 1;
  return node.children.reduce((n, c) => n + countFiles(c), 0);
}

// Filter selection, kept module-scoped so it survives the project page's
// frequent full re-renders (a card transition rebuilds the whole page). Reset
// when the page switches to a different project.
let fileFilter: {
  projectId: string;
  category: FileCategory | "all";
  ext: string;
  query: string;
} = {
  projectId: "",
  category: "all",
  ext: "all",
  query: "",
};

// Which folder paths the user has explicitly unfurled, persisted across the
// page's frequent full re-renders (like fileFilter). The tree starts fully
// furled, so this begins empty and is reset when the page switches projects.
// While a filter is active every folder renders open regardless of this set.
let expandedDirs = new Set<string>();

// Whether the whole Files widget is unfolded. Furled by default so the section
// stays out of the way until wanted; persisted (like expandedDirs) so a card
// transition's full re-render doesn't snap it shut while the user is in it.
let filesSectionOpen = false;

// Build the Files widget shell synchronously (so the page's widget order is
// preserved), then fetch this project's files lazily and populate the body when
// they resolve. The fetch is guarded against races: the project page re-renders
// frequently (a card transition rebuilds it), so a stale result that arrives
// after the section was replaced — or after a switch to another project — must
// not populate the new DOM. `section.isConnected` is the minimal robust guard.
function filesWidget(
  projectId: string,
  listFiles: (projectId: string) => Promise<FileEntry[]>,
  onOpenFile?: (path: string) => void,
): HTMLElement {
  const { section, body } = widget("Files", {
    collapsible: true,
    open: filesSectionOpen,
    onToggle: (open) => {
      filesSectionOpen = open;
    },
  });

  const loading = document.createElement("p");
  loading.className = "project-widget-empty";
  loading.textContent = "Loading…";
  body.append(loading);

  // The isConnected guard below relies on renderProjectPage rebuilding a fresh
  // `section` each call (via container.replaceChildren()), so a stale fetch can
  // only ever target its own now-detached section — never the live one. If that
  // invariant ever changes (e.g. DOM reuse across renders), this needs a
  // per-render generation token instead.
  void listFiles(projectId)
    .then((repoFiles) => {
      // Bail if this section was detached before the fetch resolved (page
      // re-rendered, or the user navigated to a different project).
      if (!section.isConnected) return;
      renderFilesBody(body, projectId, repoFiles, onOpenFile);
    })
    .catch(() => {
      // The list call can reject (host down, dropped connection, unreadable
      // root, server throw). Same detachment guard, then show an error state
      // instead of hanging on "Loading…" forever.
      if (!section.isConnected) return;
      body.replaceChildren();
      const err = document.createElement("p");
      err.className = "project-widget-empty";
      err.textContent = "Couldn't load files.";
      body.append(err);
    });
  return section;
}

// File category predicates — each tests whether a file belongs to a named
// category shown as its own section below the file tree on local projects.
type FilePredicate = (path: string) => boolean;

const FILE_CATEGORIES: { title: string; match: FilePredicate }[] = [
  {
    title: "Agent Config",
    match: (p: string) => {
      const name = p.split("/").pop() ?? "";
      return /^(AGENTS|CLAUDE|CODEBUDDY)\.md$/.test(name) || /^(AGENTS|CLAUDE|CODEBUDDY)\.local\.md$/.test(name);
    },
  },
  {
    title: "Skills",
    match: (p: string) => p.includes("/skills/"),
  },
  {
    title: "ADRs",
    match: (p: string) => p.startsWith("docs/adr/"),
  },
  {
    title: "Plans",
    match: (p: string) => p.startsWith("docs/plans/"),
  },
];

// A compact files section for a single category — a collapsible widget that
// fetches the project's files independently, filters to the matching subset,
// and renders a flat list of clickable rows. Handles loading and error states.
function filesCategoryWidget(
  title: string,
  match: FilePredicate,
  projectId: string,
  listFiles: (projectId: string) => Promise<FileEntry[]>,
  onOpenFile: ((path: string) => void) | undefined,
): HTMLElement {
  const { section, body } = widget(title, { collapsible: true });

  const loading = document.createElement("p");
  loading.className = "project-widget-empty";
  loading.textContent = "Loading…";
  body.append(loading);

  void listFiles(projectId)
    .then((repoFiles) => {
      if (!section.isConnected) return;
      body.replaceChildren();
      const matches = repoFiles.filter((f) => match(f.path));
      if (matches.length === 0) {
        const empty = document.createElement("p");
        empty.className = "project-widget-empty";
        empty.textContent = "None";
        body.append(empty);
        return;
      }
      for (const f of matches) {
        const row = document.createElement("button");
        row.className = "project-file-row";
        row.type = "button";
        row.title = f.path;
        const name = document.createElement("span");
        name.className = "project-file-name";
        name.textContent = f.title;
        row.append(name);
        if (onOpenFile) row.addEventListener("click", () => onOpenFile(f.path));
        body.append(row);
      }
    })
    .catch(() => {
      if (!section.isConnected) return;
      body.replaceChildren();
      const err = document.createElement("p");
      err.className = "project-widget-empty";
      err.textContent = "Couldn't load.";
      body.append(err);
    });

  return section;
}

// Pure renderer: populate a Files widget body from a known files array. Split
// out from filesWidget so the shell can mount before the per-project fetch
// resolves; all the filter/tree/chip logic lives here, driven by the array.
function renderFilesBody(
  body: HTMLElement,
  projectId: string,
  repoFiles: FileEntry[],
  onOpenFile?: (path: string) => void,
): void {
  body.replaceChildren();
  if (repoFiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "project-widget-empty";
    empty.textContent = "No files in this project.";
    body.append(empty);
    return;
  }

  // A fresh project starts unfiltered and fully furled; the same project keeps
  // the prior filter choice and unfurled folders.
  if (fileFilter.projectId !== projectId) {
    fileFilter = { projectId, category: "all", ext: "all", query: "" };
    expandedDirs = new Set();
    filesSectionOpen = false;
  }

  // Per-category counts drive the chip labels (and let us hide empty chips).
  const categoryCounts = new Map<FileCategory, number>();
  for (const f of repoFiles) {
    const c = categoryOf(f.path);
    categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }

  const filters = document.createElement("div");
  filters.className = "project-file-filters";
  const chips = document.createElement("div");
  chips.className = "project-file-chips";
  const extSel = document.createElement("select");
  extSel.className = "project-file-ext";
  extSel.title = "File type";
  filters.append(chips, extSel);

  const list = document.createElement("div");
  list.className = "project-file-list";

  // Free-text search over the file paths. Typing narrows the tree live (and
  // auto-unfurls it, like a category chip). The value is seeded from the
  // persisted query so a full page re-render restores what was typed.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "project-file-search";
  search.placeholder = "Search files…";
  search.value = fileFilter.query;
  search.addEventListener("input", () => {
    fileFilter.query = search.value;
    renderTree();
  });

  // The files visible under the current category (ext filter not yet applied) —
  // used both to populate the extension dropdown and to render the rows.
  const inCategory = (): FileEntry[] =>
    fileFilter.category === "all"
      ? repoFiles
      : repoFiles.filter((f) => categoryOf(f.path) === fileFilter.category);

  const renderChips = (): void => {
    chips.replaceChildren();
    const mkChip = (cat: FileCategory | "all", label: string, count: number): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "project-file-chip";
      if (fileFilter.category === cat) b.classList.add("is-active");
      b.textContent = `${label} ${count}`;
      b.addEventListener("click", () => {
        fileFilter = { projectId, category: cat, ext: "all", query: fileFilter.query };
        renderChips();
        renderExtOptions();
        renderTree();
      });
      chips.append(b);
    };
    mkChip("all", "All", repoFiles.length);
    for (const cat of CATEGORY_ORDER) {
      const n = categoryCounts.get(cat) ?? 0;
      if (n > 0) mkChip(cat, CATEGORY_LABELS[cat], n);
    }
  };

  const renderExtOptions = (): void => {
    extSel.replaceChildren();
    const counts = new Map<string, number>();
    for (const f of inCategory()) {
      const e = extOf(f.path) || "(none)";
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "All types";
    extSel.append(all);
    for (const e of [...counts.keys()].sort()) {
      const opt = document.createElement("option");
      opt.value = e;
      opt.textContent = `${e === "(none)" ? "(no ext)" : "." + e} (${counts.get(e)})`;
      extSel.append(opt);
    }
    // Keep the prior ext selection if it still exists under the new category.
    extSel.value = counts.has(fileFilter.ext) || fileFilter.ext === "all" ? fileFilter.ext : "all";
    fileFilter.ext = extSel.value;
  };
  extSel.addEventListener("change", () => {
    fileFilter.ext = extSel.value;
    renderTree();
  });

  // Auto-unfurl when a real category chip (Docs/Code/Config/Other) is active or
  // a search is in progress — both are "show me these files" gestures, so the
  // matches need to be visible. "All" with an empty search and the extension
  // dropdown leave folder state alone, so the tree returns to its furled resting
  // state and only the user's explicitly-opened folders show.
  const filterActive = (): boolean =>
    fileFilter.category !== "all" || fileFilter.query.trim() !== "";

  // Render one tree node: a file as an open-on-click row, a folder as a nested
  // <details> whose open state persists in expandedDirs (or is forced open while
  // a filter is active).
  const renderNode = (node: FileTreeNode): HTMLElement => {
    if (!node.isDir) {
      const row = document.createElement("button");
      row.className = "project-file-row";
      row.type = "button";
      const name = document.createElement("span");
      name.className = "project-file-name";
      name.textContent = node.name;
      row.append(name);
      if (onOpenFile) row.addEventListener("click", () => onOpenFile(node.path));
      return row;
    }
    const details = document.createElement("details");
    details.className = "project-tree-dir";
    details.open = filterActive() || expandedDirs.has(node.path);
    const summary = document.createElement("summary");
    summary.className = "project-tree-dir-head";
    const label = document.createElement("span");
    label.className = "project-tree-dir-name";
    label.textContent = node.name;
    const count = document.createElement("span");
    count.className = "project-tree-dir-count";
    count.textContent = String(countFiles(node));
    summary.append(label, count);
    details.append(summary);
    details.addEventListener("toggle", () => {
      if (details.open) expandedDirs.add(node.path);
      else expandedDirs.delete(node.path);
    });
    for (const child of node.children) details.append(renderNode(child));
    return details;
  };

  const renderTree = (): void => {
    list.replaceChildren();
    const files = inCategory().filter(
      (f) =>
        (fileFilter.ext === "all" || (extOf(f.path) || "(none)") === fileFilter.ext) &&
        matchesSearch(f.path, fileFilter.query),
    );
    if (files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "project-widget-empty";
      empty.textContent = fileFilter.query.trim()
        ? "No files match your search."
        : "No files of this type.";
      list.append(empty);
      return;
    }
    const tree = buildFileTree(files.map((f) => f.path));
    for (const node of tree) list.append(renderNode(node));
  };

  renderChips();
  renderExtOptions();
  renderTree();
  body.append(search, filters, list);
}

// --- Widget shell ---------------------------------------------------------

function widget(
  title: string,
  // When collapsible, the whole widget renders as a <details> whose body folds
  // away. `open` seeds the initial state and `onToggle` reports user changes so
  // the caller can persist them across the page's frequent re-renders.
  opts?: { collapsible?: boolean; open?: boolean; onToggle?: (open: boolean) => void },
): { section: HTMLElement; body: HTMLElement } {
  if (opts?.collapsible) {
    const section = document.createElement("details");
    section.className = "project-widget project-widget--foldable";
    section.open = opts.open ?? false;
    const head = document.createElement("summary");
    head.className = "project-widget-head project-widget-head--summary";
    head.textContent = title;
    const body = document.createElement("div");
    body.className = "project-widget-body";
    section.append(head, body);
    if (opts.onToggle) section.addEventListener("toggle", () => opts.onToggle!(section.open));
    return { section, body };
  }
  const section = document.createElement("section");
  section.className = "project-widget";
  const head = document.createElement("h2");
  head.className = "project-widget-head";
  head.textContent = title;
  const body = document.createElement("div");
  body.className = "project-widget-body";
  section.append(head, body);
  return { section, body };
}

// --- Items by state (issue tracker + active sessions, combined) -----------

function itemsWidget(
  projectId: string,
  onChange: () => void,
  onStartSession?: (item: Item, agent: Agent) => void,
  onOpenSession?: (id: string) => void,
  onOpenDoc?: (path: string, projectId: string) => void,
): { section: HTMLElement; render: () => void } {
  const { section, body } = widget("Items by state");

  // A per-project "Show completed" switch in the widget header. When on, the
  // list keeps completed cards/sessions instead of fading them out after the
  // dwell time. Persisted on the project (default off).
  const toggle = document.createElement("label");
  toggle.className = "issue-show-completed";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = getProject(projectId)?.showCompleted ?? false;
  toggle.append(cb, document.createTextNode(" Show completed"));
  cb.addEventListener("change", () => {
    updateProject(projectId, { showCompleted: cb.checked });
    onChange();
    render();
  });
  section.querySelector(".project-widget-head")?.append(toggle);

  const list = document.createElement("div");
  list.className = "issue-list";

  const render = (): void => {
    const nowMs = Date.now();
    const ttlMs = loadSettings().completeFadeHours * 60 * 60 * 1000;
    const showCompleted = getProject(projectId)?.showCompleted ?? false;
    const allItems = itemsByProject(projectId);
    // Completed items fall off the list after the configured dwell time,
    // mirroring the board's Complete column — unless the project opts to keep
    // showing them.
    const items = showCompleted
      ? allItems
      : allItems.filter((i) => !isExpiredComplete(i, nowMs, ttlMs));
    // Re-render at the soonest moment a still-visible completed item crosses its
    // TTL, so an idle page drops it without waiting for the next interaction.
    // Not needed while showing completed items (nothing fades out).
    if (dropTimer) clearTimeout(dropTimer);
    let soonestDrop = Infinity;
    if (!showCompleted) {
      for (const i of allItems) {
        if (i.state !== "complete" || typeof i.completedAt !== "number") continue;
        const dropAt = i.completedAt + ttlMs;
        if (dropAt > nowMs && dropAt < soonestDrop) soonestDrop = dropAt;
      }
    }
    if (soonestDrop !== Infinity) {
      dropTimer = setTimeout(render, soonestDrop - nowMs + 50);
    }
    if (items.length === 0) {
      list.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "project-widget-empty";
      empty.textContent = "No items yet. Add one above.";
      list.append(empty);
      return;
    }
    renderIssueGroups(list, items, {
      states: STATES,
      onMutate: () => {
        onChange();
        render();
      },
      onStartSession,
      onOpenSession,
      onOpenDoc,
      // State is conveyed by the group headers and the project is fixed on a
      // project page, so the inline pickers are dropped — both stay editable on
      // the card (its title opens the card modal).
      showMeta: false,
    });
  };

  body.append(list);
  render();
  return { section, render };
}

