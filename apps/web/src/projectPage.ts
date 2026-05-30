import { LIFECYCLE_ORDER, type CardState } from "@orden/outliner";
import type { EditorView } from "prosemirror-view";
import type { FileEntry } from "@orden/host-api";
import { itemsByProject, addItem, setItemState, setItemProject, type Item } from "./cards";
import { getProject, listProjects, type Project } from "./projects";
import { agentLauncher, markFor } from "./agentMarks";
import { listSessions, setSessionProject, type Agent, type Session } from "./sessions";
import { makeOutlineEditor } from "./outlineEditor";

const STATES: CardState[] = [...LIFECYCLE_ORDER];

// The currently-mounted notes editor (one project page is shown at a time).
// Torn down whenever the page re-renders so detached EditorViews don't leak.
let notesView: EditorView | null = null;

// True while the user is typing in the embedded notes outline. Callers should
// skip re-rendering the project page on remote changes when this is set, or
// they'd destroy the editor mid-keystroke (mirrors journal.refresh's guard).
export function projectNotesHasFocus(): boolean {
  return notesView?.hasFocus() ?? false;
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
): void {
  const project = getProject(projectId);
  // Tear down the previous render's notes editor before replacing the DOM.
  try {
    notesView?.destroy();
  } catch {
    /* ignore */
  }
  notesView = null;
  container.replaceChildren();
  if (!project) {
    const p = document.createElement("p");
    p.className = "pages-empty";
    p.textContent = "Project not found.";
    container.append(p);
    return;
  }

  const heading = document.createElement("h1");
  heading.className = "project-title";
  heading.textContent = project.name;

  // Source subtitle: the path for local projects, the source kind for remote
  // ones. Ephemeral projects (e.g. Homeroom) show no subtitle — "ephemeral" is
  // an implementation detail, not something to surface.
  const metaText =
    project.source.kind === "local"
      ? project.source.path
      : project.source.kind === "ephemeral"
        ? ""
        : project.source.kind;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = metaText;

  container.append(heading, ...(metaText ? [meta] : []));
  container.append(
    sessionsWidget(projectId, onOpenSession, onNewSession),
    itemsWidget(projectId, onChange, onStartSession),
    // File explorer — only for file-backed (local) projects. Ephemeral/ssh/s3
    // projects have no browsable local files, so the widget is omitted.
    ...(project.source.kind === "local" ? [filesWidget(repoFiles, onOpenFile)] : []),
    notesWidget(project),
    activityWidget(),
  );
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

// --- 1. Active sessions ---------------------------------------------------

function sessionsWidget(
  projectId: string,
  onOpenSession?: (id: string) => void,
  onNewSession?: (agent: Agent) => void,
): HTMLElement {
  const { section, body } = widget("Active sessions");

  const sessions = listSessions().filter((s: Session) => s.projectId === projectId);
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "project-widget-empty";
    empty.textContent = "No active sessions for this project.";
    body.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "project-sess-list";
    for (const s of sessions) {
      const row = document.createElement("button");
      row.className = "project-sess-row";
      row.type = "button";
      const mark = document.createElement("span");
      mark.className = "project-sess-mark";
      mark.innerHTML = markFor(s.agent); // static, author-controlled brand SVG
      mark.title = s.agent;
      const title = document.createElement("span");
      title.className = "project-sess-title";
      title.textContent = s.title;
      row.append(mark, title);
      if (onOpenSession) row.addEventListener("click", () => onOpenSession(s.id));
      list.append(row);
    }
    body.append(list);
  }

  // Start a new project-scoped session via the Claude / opencode brand marks.
  if (onNewSession) {
    const newRow = document.createElement("div");
    newRow.className = "project-sess-new";
    const label = document.createElement("span");
    label.className = "project-sess-new-label";
    label.textContent = "New session";
    newRow.append(label, agentLauncher((agent) => onNewSession(agent)));
    body.append(newRow);
  }

  return section;
}

// --- 2. Items by state (the existing issue tracker) -----------------------

function itemsWidget(
  projectId: string,
  onChange: () => void,
  onStartSession?: (item: Item, agent: Agent) => void,
): HTMLElement {
  const { section, body } = widget("Items by state");

  const addRow = document.createElement("div");
  addRow.className = "project-add";
  const input = document.createElement("input");
  input.className = "project-add-input";
  input.placeholder = "Add an item…";
  const addBtn = document.createElement("button");
  addBtn.className = "project-add-btn";
  addBtn.textContent = "Add";

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
      details.open = true;
      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="issue-group-state" data-state="${state}">${STATE_LABELS[state]}</span> <span class="issue-group-count">${group.length}</span>`;
      details.append(summary);
      for (const item of group) {
        const row = document.createElement("div");
        row.className = "issue-row";
        const title = document.createElement("span");
        title.className = "issue-title";
        title.textContent = item.title;
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
          // Move the linked session too, so it follows the card off this page
          // instead of stranding under its old project's "Active sessions".
          if (item.sessionId) setSessionProject(item.sessionId, projSel.value);
          onChange();
          render();
        });
        row.append(title, select, projSel);
        // No AI conversation yet → start one (Claude / opencode) from the row.
        if (!item.sessionId && onStartSession) {
          row.append(agentLauncher((agent) => onStartSession(item, agent)));
        }
        details.append(row);
      }
      list.append(details);
    }
  };

  const commit = (): void => {
    const title = input.value.trim();
    if (!title) return;
    addItem(projectId, title);
    input.value = "";
    onChange();
    render();
  };
  addBtn.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  addRow.append(input, addBtn);

  body.append(addRow, list);
  render();
  return section;
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
