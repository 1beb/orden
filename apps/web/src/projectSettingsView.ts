// The project-settings main-panel overlay — the per-project analogue of the app
// Settings view. Opened from the project page's cog, it's the third overlay on
// the makeViewToggler seam (settings / help / project-settings): open remembers
// the prior view, ✕ / Escape restore it. Unlike app settings (which write
// through on every change), project edits are staged and applied on Save — a
// path change can move where agents launch, so it shouldn't take effect on a
// stray keystroke. Archiving (a reversible hide, not a delete) lives in its own
// group at the bottom.

import {
  getProject,
  updateProject,
  canPickDirectory,
  pickDirectory,
  DEFAULT_PROJECT_ID,
} from "./projects";
import type { Agent } from "./sessions";

export interface ProjectSettingsDeps {
  // Refresh the sidebar list, view title, and project page after a save (a
  // rename / re-path must propagate everywhere the name or path is shown).
  onSaved: () => void;
  // Toggle the project's archived flag. Archiving hides it from the sidebar,
  // pickers, board, and search (its cards/sessions are kept); unarchive brings
  // it back. Reversible, so no confirmation.
  onArchiveProject: (id: string, archived: boolean) => void;
  // Close the overlay, returning to the prior view (the toggler's close()).
  close: () => void;
}

const AGENT_OPTIONS: { value: "" | Agent; label: string }[] = [
  { value: "", label: "Ask each time" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "opencode" },
];

const ISOLATION_OPTIONS = [
  ["", "Inherit global setting"],
  ["on", "On — per-session worktrees"],
  ["off", "Off — sessions share the checkout"],
] as const;

// A stacked settings row (label over control) — the project fields are text
// inputs and selects that read better stacked than in the label-left/control-
// right rhythm the app-settings switches use.
function stackedRow(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row settings-row-stack";
  const label = document.createElement("span");
  label.className = "settings-row-label";
  label.textContent = labelText;
  row.append(label, control);
  if (hint) {
    const h = document.createElement("p");
    h.className = "settings-hint";
    h.textContent = hint;
    row.append(h);
  }
  return row;
}

export function renderProjectSettings(
  container: HTMLElement,
  projectId: string,
  deps: ProjectSettingsDeps,
): void {
  container.replaceChildren();
  const project = getProject(projectId);
  if (!project) {
    const p = document.createElement("p");
    p.className = "pages-empty";
    p.textContent = "Project not found.";
    container.append(p);
    return;
  }

  const isLocal = project.source.kind === "local";
  const currentPath = project.source.kind === "local" ? project.source.path : "";

  const page = document.createElement("div");
  page.className = "settings-page";

  // Header: title + ✕ close (mirrors the app-settings / help chrome).
  const head = document.createElement("header");
  head.className = "settings-page-head";
  const title = document.createElement("h1");
  title.className = "settings-page-title";
  title.textContent = "Project settings";
  const close = document.createElement("button");
  close.className = "settings-close";
  close.id = "project-settings-close";
  close.title = "Close settings";
  close.setAttribute("aria-label", "Close project settings");
  close.textContent = "✕";
  head.append(title, close);
  page.append(head);

  // --- Details group ---
  const details = document.createElement("section");
  details.className = "settings-group";
  const dh = document.createElement("h2");
  dh.className = "settings-group-title";
  dh.textContent = "Details";
  details.append(dh);

  const nameInput = document.createElement("input");
  nameInput.className = "settings-input";
  nameInput.placeholder = "Project name";
  nameInput.value = project.name;
  details.append(stackedRow("Name", nameInput));

  const pathInput = document.createElement("input");
  pathInput.className = "settings-input";
  pathInput.placeholder = "/path/to/project";
  pathInput.value = currentPath;
  if (isLocal) {
    const pathRow = document.createElement("div");
    pathRow.className = "settings-input-row";
    pathRow.append(pathInput);
    if (canPickDirectory()) {
      const browse = document.createElement("button");
      browse.type = "button";
      browse.className = "settings-browse-btn";
      browse.textContent = "Browse…";
      browse.addEventListener("click", async () => {
        browse.disabled = true;
        try {
          const picked = await pickDirectory(pathInput.value.trim() || undefined);
          if (picked) pathInput.value = picked;
        } finally {
          browse.disabled = false;
        }
      });
      pathRow.append(browse);
    }
    details.append(
      stackedRow(
        "Folder path",
        pathRow,
        "Where the project lives — agents launch here by default. Changing it moves where new sessions run.",
      ),
    );
  }

  const agentSel = document.createElement("select");
  agentSel.className = "settings-select";
  for (const o of AGENT_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = (project.defaultAgent ?? "") === o.value;
    agentSel.append(opt);
  }
  details.append(
    stackedRow("Default agent", agentSel, "Pre-selected when you start a session here."),
  );

  const isoSel = document.createElement("select");
  isoSel.className = "settings-select";
  for (const [value, label] of ISOLATION_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.selected =
      (project.worktreeIsolation === undefined && value === "") ||
      (project.worktreeIsolation === true && value === "on") ||
      (project.worktreeIsolation === false && value === "off");
    isoSel.append(opt);
  }
  details.append(
    stackedRow(
      "Session isolation",
      isoSel,
      "Whether sessions of this project run in their own git worktree.",
    ),
  );

  const wdInput = document.createElement("input");
  wdInput.className = "settings-input";
  wdInput.value = project.workingDir ?? "";
  const syncWdPlaceholder = (): void => {
    wdInput.placeholder = (isLocal ? pathInput.value.trim() : "") || "Defaults to the folder path";
  };
  syncWdPlaceholder();
  pathInput.addEventListener("input", syncWdPlaceholder);
  details.append(
    stackedRow(
      "Working directory",
      wdInput,
      "Override the cwd agents launch in. Stored now; host honoring is deferred.",
    ),
  );

  const error = document.createElement("p");
  error.className = "settings-error";
  error.hidden = true;
  details.append(error);

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "settings-save-btn";
  save.textContent = "Save changes";
  actions.append(save);
  details.append(actions);
  page.append(details);

  const showError = (msg: string): void => {
    error.textContent = msg;
    error.hidden = false;
  };
  save.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      showError("A project needs a name.");
      nameInput.focus();
      return;
    }
    const path = pathInput.value.trim();
    if (isLocal && !path) {
      showError("A local project needs a folder path.");
      pathInput.focus();
      return;
    }
    updateProject(project.id, {
      name,
      path: isLocal ? path : undefined,
      defaultAgent: (agentSel.value || null) as Agent | null,
      workingDir: wdInput.value.trim() || null,
      worktreeIsolation: isoSel.value === "" ? null : isoSel.value === "on",
    });
    deps.onSaved();
    deps.close();
  });

  // --- Archive (Homeroom can't be archived) ---
  if (project.id !== DEFAULT_PROJECT_ID) {
    const archived = project.archived === true;
    const group = document.createElement("section");
    group.className = "settings-group";
    const gh = document.createElement("h2");
    gh.className = "settings-group-title";
    gh.textContent = "Archive";
    group.append(gh);

    const desc = document.createElement("p");
    desc.className = "settings-hint";
    desc.textContent = archived
      ? "This project is archived — hidden from the sidebar, pickers, board, and search. Its cards and sessions are kept. Unarchive to bring it back."
      : "Archiving hides this project from the sidebar, pickers, board, and search. Its cards and sessions are kept, and you can unarchive it later from the Projects page.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-archive-btn";
    btn.textContent = archived ? "Unarchive project" : "Archive project";
    btn.addEventListener("click", () => {
      deps.onArchiveProject(project.id, !archived);
      deps.close();
    });
    group.append(desc, btn);
    page.append(group);
  }

  container.append(page);
}
