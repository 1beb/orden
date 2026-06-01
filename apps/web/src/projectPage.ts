import { LIFECYCLE_ORDER, type CardState } from "@orden/outliner";
import type { EditorView } from "prosemirror-view";
import type { FileEntry } from "@orden/host-api";
import {
  itemsByProject,
  addItem,
  setItemState,
  setItemProject,
  cardSessionIds,
  type Item,
} from "./cards";
import {
  getProject,
  listProjects,
  updateProject,
  DEFAULT_PROJECT_ID,
  type Project,
} from "./projects";
import { agentLauncher, markFor } from "./agentMarks";
import {
  sessionsForCard,
  setSessionProject,
  isSessionComplete,
  listSessions,
  type Agent,
} from "./sessions";
import { openDialog } from "./modal";
import { makeOutlineEditor } from "./outlineEditor";
import { openCardModal } from "./cardModal";

const STATES: CardState[] = [...LIFECYCLE_ORDER];

// The currently-mounted notes editor (one project page is shown at a time).
// Torn down whenever the page re-renders so detached EditorViews don't leak.
let notesView: EditorView | null = null;

// The container the page is mounted in, captured each render so focus guards
// can scope themselves to "is the user typing somewhere on this page".
let pageContainer: HTMLElement | null = null;

// True while the user is typing in the embedded notes outline. Callers should
// skip re-rendering the project page on remote changes when this is set, or
// they'd destroy the editor mid-keystroke (mirrors journal.refresh's guard).
export function projectNotesHasFocus(): boolean {
  return notesView?.hasFocus() ?? false;
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

// Capitalized labels for group headers and the state picker.
const STATE_LABELS: Record<CardState, string> = {
  planning: "Planning",
  "in-progress": "In-progress",
  blocked: "Blocked",
  complete: "Complete",
};

// The notes Page for a project is keyed deterministically by project id, not by
// name: a distinct key (`notes:<id>`) so it (a) survives a project rename and
// (b) does NOT collide with `[[Project: X]]`, which already routes to the
// project page itself. The notes page still appears in the Pages index and
// supports [[wiki links]] + backlinks like any other page.
function notesPageName(project: Project): string {
  return `notes:${project.id}`;
}

// Project mission-control page: a single stacked column of four widgets —
// Active sessions, Items by state (the issue tracker), Project notes (an
// embedded outliner page) and a Recent-activity feed.
export function renderProjectPage(
  container: HTMLElement,
  projectId: string,
  onChange: () => void,
  // Start an agent session from an existing card that has no conversation yet.
  onStartSession?: (item: Item, agent: Agent) => void,
  // Open an existing session in the sessions panel.
  onOpenSession?: (id: string) => void,
  // Start a NEW project-scoped session (not tied to any card).
  onNewSession?: (agent: Agent) => void,
  // Open a repo file in the review/document view (file-backed projects only).
  onOpenFile?: (path: string) => void,
  // The repo's files (path + title). The host's FileSource is single-rooted at
  // the repo for now; per-project roots come later, at which point this should
  // be scoped per project rather than the whole repo.
  repoFiles: FileEntry[] = [],
  // Called after an in-place edit (rename / re-path) so the caller can refresh
  // the sidebar list and the view title to match.
  onProjectChanged?: () => void,
  // Remove the project. `mode` decides what happens to its cards/sessions:
  // "reassign" moves them to the default project; "cascade" deletes them (and
  // kills their agents). The caller owns the cross-store work and navigation.
  onRemoveProject?: (id: string, mode: "reassign" | "cascade") => void,
): void {
  const project = getProject(projectId);
  // Tear down the previous render's notes editor before replacing the DOM.
  try {
    notesView?.destroy();
  } catch {
    /* ignore */
  }
  notesView = null;
  pageContainer = container;
  container.replaceChildren();
  if (!project) {
    const p = document.createElement("p");
    p.className = "pages-empty";
    p.textContent = "Project not found.";
    container.append(p);
    return;
  }

  // Title row + a cog menu (Edit / Remove). The header manages its own meta
  // subtitle and inline edit form; remove is delegated to the caller.
  const header = projectHeader(project, onProjectChanged, onRemoveProject);

  // Items by state now folds the active sessions in: each row carries its
  // linked session(s) as a leading brand-mark button (open directly), so there's
  // no separate Active-sessions widget to keep in sync.
  const items = itemsWidget(projectId, onChange, onStartSession, onOpenSession);
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
    // File explorer — only for file-backed (local) projects. Ephemeral/ssh/s3
    // projects have no browsable local files, so the widget is omitted.
    ...(project.source.kind === "local" ? [filesWidget(repoFiles, onOpenFile)] : []),
    notesWidget(project),
    activityWidget(),
  );
}

// --- Header: title + cog menu (edit / remove) -----------------------------

// The source subtitle: the path for local projects, the source kind for remote
// ones. Ephemeral projects (e.g. Homeroom) show none — "ephemeral" is an
// implementation detail, not something to surface.
function projectMetaText(project: Project): string {
  if (project.source.kind === "local") return project.source.path;
  if (project.source.kind === "ephemeral") return "";
  return project.source.kind;
}

function projectHeader(
  project: Project,
  onProjectChanged?: () => void,
  onRemoveProject?: (id: string, mode: "reassign" | "cascade") => void,
): HTMLElement {
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
  const syncMeta = (): void => {
    meta.textContent = projectMetaText(project);
    meta.hidden = !meta.textContent;
  };
  syncMeta();

  // Cog + dropdown menu (Edit / Remove). The menu closes on outside click.
  const cog = document.createElement("button");
  cog.type = "button";
  cog.className = "project-cog";
  cog.title = "Project settings";
  cog.setAttribute("aria-label", "Project settings");
  cog.textContent = "⚙";

  const menu = document.createElement("div");
  menu.className = "project-menu";
  menu.hidden = true;

  const closeMenu = (): void => {
    menu.hidden = true;
    document.removeEventListener("click", onDocClick, true);
  };
  const onDocClick = (e: MouseEvent): void => {
    if (!wrap.contains(e.target as Node)) closeMenu();
  };
  cog.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) {
      menu.hidden = false;
      document.addEventListener("click", onDocClick, true);
    } else {
      closeMenu();
    }
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "project-menu__item";
  editBtn.textContent = "Edit details";

  // The inline edit form, hidden until "Edit details" is chosen.
  const form = editForm(project, meta, heading, syncMeta, onProjectChanged);

  editBtn.addEventListener("click", () => {
    closeMenu();
    titleRow.hidden = true;
    meta.hidden = true;
    form.hidden = false;
    form.focus();
  });
  menu.append(editBtn);

  // Homeroom is the catch-all default and can't be removed.
  if (project.id !== DEFAULT_PROJECT_ID && onRemoveProject) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "project-menu__item project-menu__item--danger";
    removeBtn.textContent = "Remove project";
    removeBtn.addEventListener("click", () => {
      closeMenu();
      void confirmRemoveProject(project, onRemoveProject);
    });
    menu.append(removeBtn);
  }

  const cogWrap = document.createElement("div");
  cogWrap.className = "project-cog-wrap";
  cogWrap.append(cog, menu);
  titleRow.append(heading, cogWrap);
  wrap.append(titleRow, meta, form);
  // Show/hide the form's restore of the title row on cancel/save.
  form.addEventListener("project-edit-done", () => {
    titleRow.hidden = false;
    syncMeta();
    form.hidden = true;
  });
  return wrap;
}

// Inline name (+ path, for local projects) editor. Emits a "project-edit-done"
// event on its own element when the user saves or cancels, so the header can
// restore the title row. Saving persists via updateProject and notifies the
// caller to refresh the sidebar/title.
function editForm(
  project: Project,
  _meta: HTMLElement,
  heading: HTMLElement,
  syncMeta: () => void,
  onProjectChanged?: () => void,
): HTMLElement {
  const form = document.createElement("form");
  form.className = "project-edit";
  form.hidden = true;

  const nameInput = document.createElement("input");
  nameInput.className = "project-edit__input";
  nameInput.placeholder = "Project name";
  nameInput.value = project.name;

  const pathInput = document.createElement("input");
  pathInput.className = "project-edit__input";
  pathInput.placeholder = "Folder path";
  const isLocal = project.source.kind === "local";
  if (isLocal) pathInput.value = (project.source as { path: string }).path;

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "project-edit__save";
  save.textContent = "Save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "project-edit__cancel";
  cancel.textContent = "Cancel";

  const done = (): void => {
    form.dispatchEvent(new CustomEvent("project-edit-done"));
  };
  cancel.addEventListener("click", () => {
    nameInput.value = project.name;
    if (isLocal) pathInput.value = (project.source as { path: string }).path;
    done();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return; // a project must keep a name
    updateProject(project.id, { name, path: isLocal ? pathInput.value : undefined });
    heading.textContent = project.name;
    syncMeta();
    onProjectChanged?.();
    done();
  });

  form.append(nameInput, ...(isLocal ? [pathInput] : []), save, cancel);
  // Focusing the form focuses the name field (header calls form.focus()).
  form.addEventListener("focus", () => nameInput.focus());
  Object.defineProperty(form, "focus", { value: () => nameInput.focus() });
  return form;
}

// The remove confirmation flow. Counts the project's cards/sessions, offers
// "move to Homeroom" vs "delete everything", and double-confirms a cascade
// before delegating the actual removal to the caller.
async function confirmRemoveProject(
  project: Project,
  onRemoveProject: (id: string, mode: "reassign" | "cascade") => void,
): Promise<void> {
  const cardCount = itemsByProject(project.id).length;
  const sessCount = listSessions(true).filter((s) => s.projectId === project.id).length;

  // Nothing to move or destroy — a single plain confirm is enough.
  if (cardCount === 0 && sessCount === 0) {
    const ok = await openDialog({
      title: `Remove "${project.name}"?`,
      message: "This project is empty. Remove it?",
      actions: [{ id: "reassign", label: "Remove project", danger: true }],
    });
    if (ok === "reassign") onRemoveProject(project.id, "reassign");
    return;
  }

  const counts = `${cardCount} card${cardCount === 1 ? "" : "s"} and ${sessCount} session${sessCount === 1 ? "" : "s"}`;
  const choice = await openDialog({
    title: `Remove "${project.name}"`,
    message: `This project has ${counts}. What should happen to them?`,
    actions: [
      { id: "reassign", label: "Move to Homeroom & remove" },
      { id: "cascade", label: "Delete everything", danger: true },
    ],
  });
  if (!choice) return;

  if (choice === "cascade") {
    // Double-ask: a cascade is irreversible and kills running agents.
    const sure = await openDialog({
      title: "Permanently delete everything?",
      message: `This deletes ${counts} and stops their running agents. This cannot be undone.`,
      actions: [{ id: "confirm", label: "Delete everything", danger: true }],
    });
    if (sure !== "confirm") return;
  }
  onRemoveProject(project.id, choice as "reassign" | "cascade");
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
  const addBtn = document.createElement("button");
  addBtn.className = "project-add-btn";
  addBtn.textContent = "Add";

  // Create the card from the typed title and refresh the Items list. Returns the
  // new item so the launch buttons can immediately start a session on it.
  const create = (): Item | null => {
    const title = input.value.trim();
    if (!title) return null;
    const item = addItem(projectId, title);
    input.value = "";
    onChange();
    refreshItems();
    return item;
  };

  addBtn.addEventListener("click", () => create());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") create();
  });
  row.append(input, addBtn);

  // The brand marks add the item and start a session on it in one action.
  if (onStartSession) {
    row.append(
      agentLauncher((agent) => {
        const item = create();
        if (!item) return;
        onStartSession(item, agent);
        refreshItems(); // show the new item's open button
      }),
    );
  }
  return row;
}

// --- Files (file-backed projects only) ------------------------------------

function filesWidget(repoFiles: FileEntry[], onOpenFile?: (path: string) => void): HTMLElement {
  const { section, body } = widget("Files");
  if (repoFiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "project-widget-empty";
    empty.textContent = "No files in this project.";
    body.append(empty);
    return section;
  }
  const list = document.createElement("div");
  list.className = "project-file-list";
  for (const f of repoFiles) {
    const row = document.createElement("button");
    row.className = "project-file-row";
    row.type = "button";
    const name = document.createElement("span");
    name.className = "project-file-name";
    name.textContent = f.path.split("/").pop() ?? f.path;
    const meta = document.createElement("span");
    meta.className = "project-file-meta";
    meta.textContent = f.path.includes("/") ? f.path.replace(/\/[^/]+$/, "") : "/";
    row.append(name, meta);
    if (onOpenFile) row.addEventListener("click", () => onOpenFile(f.path));
    list.append(row);
  }
  body.append(list);
  return section;
}

// --- Widget shell ---------------------------------------------------------

function widget(title: string): { section: HTMLElement; body: HTMLElement } {
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

// A leading control for an item row. If the item has linked session(s), render
// one brand-mark button per session that opens it directly (the active-session
// affordance, folded onto the row). Otherwise render the Claude/opencode
// launcher to start a session on it.
function rowLeader(
  item: Item,
  onStartSession?: (item: Item, agent: Agent) => void,
  onOpenSession?: (id: string) => void,
): HTMLElement {
  const lead = document.createElement("span");
  lead.className = "issue-row-lead";
  const sessions = sessionsForCard(item);
  if (sessions.length > 0) {
    for (const s of sessions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "issue-sess-open";
      if (isSessionComplete(s)) b.classList.add("is-complete");
      b.innerHTML = markFor(s.agent); // static, author-controlled brand SVG
      b.title = `Open ${s.agent} session: ${s.title}`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenSession?.(s.id);
      });
      lead.append(b);
    }
  } else if (onStartSession) {
    lead.append(agentLauncher((agent) => onStartSession(item, agent)));
  }
  return lead;
}

function itemsWidget(
  projectId: string,
  onChange: () => void,
  onStartSession?: (item: Item, agent: Agent) => void,
  onOpenSession?: (id: string) => void,
): { section: HTMLElement; render: () => void } {
  const { section, body } = widget("Items by state");

  const list = document.createElement("div");
  list.className = "issue-list";

  const render = (): void => {
    const items = itemsByProject(projectId);
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "project-widget-empty";
      empty.textContent = "No items yet. Add one above.";
      list.append(empty);
      return;
    }
    for (const state of STATES) {
      const group = items.filter((i) => i.state === state);
      if (group.length === 0) continue;
      const details = document.createElement("details");
      details.className = "issue-group";
      // Completed cards can pile up; show the group but keep it furled until the
      // user opens it. Every other state defaults open.
      details.open = state !== "complete";
      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="issue-group-state" data-state="${state}">${STATE_LABELS[state]}</span> <span class="issue-group-count">${group.length}</span>`;
      details.append(summary);
      for (const item of group) {
        const row = document.createElement("div");
        row.className = "issue-row";
        // Leading control: open the linked session(s) directly, or — if none —
        // launch one. This is what folds Active sessions into the row.
        const lead = rowLeader(item, onStartSession, onOpenSession);
        // Click the title to open the card's detail modal (same modal the
        // kanban board opens). Mutations there refresh this list;
        // onStart/onOpen fall back to no-ops if the page didn't wire them.
        const title = document.createElement("button");
        title.type = "button";
        title.className = "issue-title";
        title.textContent = item.title;
        title.addEventListener("click", () => {
          openCardModal(item.id, {
            onStartSession: (it, agent) => onStartSession?.(it, agent),
            onOpenSession: (id) => onOpenSession?.(id),
            onChange: () => {
              onChange();
              render();
            },
          });
        });
        const select = document.createElement("select");
        select.className = "issue-state";
        for (const s of STATES) {
          const opt = document.createElement("option");
          opt.value = s;
          opt.textContent = STATE_LABELS[s];
          opt.selected = s === item.state;
          select.append(opt);
        }
        select.addEventListener("change", () => {
          setItemState(item.id, select.value as CardState);
          onChange();
          render();
        });
        // Move the card to another project (it then leaves this page's list).
        const projSel = document.createElement("select");
        projSel.className = "issue-project";
        projSel.title = "Project";
        for (const p of listProjects()) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name;
          opt.selected = p.id === item.projectId;
          projSel.append(opt);
        }
        projSel.addEventListener("change", () => {
          setItemProject(item.id, projSel.value);
          // Move the linked sessions too, so they follow the card off this page
          // instead of stranding under its old project.
          for (const sid of cardSessionIds(item)) setSessionProject(sid, projSel.value);
          onChange();
          render();
        });
        row.append(lead, title, select, projSel);
        details.append(row);
      }
      list.append(details);
    }
  };

  body.append(list);
  render();
  return { section, render };
}

// --- 3. Project notes (embedded outliner page) ----------------------------

// Keep a reference to any mounted notes editor so callers re-rendering the page
// don't leak detached EditorViews. Stored per render; the previous one is torn
// down when renderProjectPage replaces the container's children.
function notesWidget(project: Project): HTMLElement {
  const { section, body } = widget("Project notes");
  const host = document.createElement("div");
  host.className = "journal-editor project-notes";
  body.append(host);
  // Wiki-link clicks inside notes route through the app's page opener (the
  // journal controller in main.ts), broadcast as a CustomEvent so projectPage
  // stays decoupled from main's wiring. Torn down on the next page render.
  notesView = makeOutlineEditor(host, notesPageName(project), (target) => {
    document.dispatchEvent(new CustomEvent("orden:open-page", { detail: { name: target } }));
  });
  return section;
}

// --- 4. Recent activity ---------------------------------------------------

// STUBBED ON PURPOSE: a reverse-chron activity feed needs an event log (or at
// least timestamps on cards/sessions), and orden has neither today — cards and
// sessions carry no created/updated time, and there's no append-only event
// store. Rather than fabricate fake timestamps or invent an ordering that
// implies recency it can't support, render a clearly-labeled placeholder. When
// an event log lands, replace this with the real reverse-chron feed.
function activityWidget(): HTMLElement {
  const { section, body } = widget("Recent activity");
  const note = document.createElement("p");
  note.className = "project-widget-empty";
  note.textContent = "Activity feed — needs an event log; coming soon.";
  body.append(note);
  return section;
}
