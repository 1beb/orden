// The add/edit project modal. One component for both flows (mode "create" |
// "edit"), built on the shared .preview-overlay / .preview-modal shell so it
// matches the card/confirm dialogs. It replaces two divergent, cramped paths:
// the sidebar add-project form (main.ts) and the inline editForm (projectPage).
//
// Scope (local nodehost projects): name + folder path + a couple of session
// defaults (default agent, optional working-dir override). ssh/s3 sources and
// per-project file scoping are deferred — see the brainstorm in this PR.
import {
  addProject,
  updateProject,
  canPickDirectory,
  pickDirectory,
  type Project,
} from "./projects";
import type { Agent } from "./sessions";

export interface ProjectModalOptions {
  mode: "create" | "edit";
  // The project being edited (required for mode "edit"; ignored for "create").
  project?: Project;
  // Called with the created/updated project after a successful save, so the
  // caller can refresh the sidebar list / page / title.
  onSaved?: (project: Project) => void;
}

const AGENT_OPTIONS: { value: "" | Agent; label: string }[] = [
  { value: "", label: "Ask each time" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "opencode" },
];

// Build a labeled field (label + control) for the modal body.
function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "project-modal__field";
  const label = document.createElement("span");
  label.className = "project-modal__label";
  label.textContent = labelText;
  wrap.append(label, control);
  if (hint) {
    const h = document.createElement("span");
    h.className = "project-modal__hint";
    h.textContent = hint;
    wrap.append(h);
  }
  return wrap;
}

export function openProjectModal(opts: ProjectModalOptions): void {
  const editing = opts.mode === "edit" ? opts.project : undefined;
  // Whether this project has a folder path to edit. New projects are always
  // local; editing an ephemeral project (e.g. Homeroom) hides the path field.
  const isLocal = editing ? editing.source.kind === "local" : true;
  const currentPath =
    editing && editing.source.kind === "local" ? editing.source.path : "";

  const overlay = document.createElement("div");
  overlay.className = "preview-overlay";

  let settled = false;
  const close = (): void => {
    if (settled) return;
    settled = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  const modal = document.createElement("div");
  modal.className = "preview-modal project-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const header = document.createElement("header");
  header.textContent = opts.mode === "create" ? "Add project" : "Edit project";
  modal.append(header);

  const form = document.createElement("form");
  form.className = "project-modal__body";

  // --- Name (required) ---
  const nameInput = document.createElement("input");
  nameInput.className = "project-modal__input";
  nameInput.placeholder = "Project name";
  nameInput.value = editing?.name ?? "";
  form.append(field("Name", nameInput));

  // --- Folder path (local only; required when shown) ---
  const pathInput = document.createElement("input");
  pathInput.className = "project-modal__input";
  pathInput.placeholder = "/path/to/project";
  pathInput.value = currentPath;
  // A native "Browse…" folder chooser, shown only when the host supports it
  // (local nodehost with zenity/kdialog). The browser can't produce a real
  // filesystem path, so this routes through the host.
  const pathRow = document.createElement("div");
  pathRow.className = "project-modal__path-row";
  pathRow.append(pathInput);
  if (canPickDirectory()) {
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "project-modal__browse";
    browse.textContent = "Browse…";
    browse.addEventListener("click", async () => {
      browse.disabled = true;
      try {
        const picked = await pickDirectory(pathInput.value.trim() || undefined);
        if (picked) {
          pathInput.value = picked;
          // Fire input so the working-dir placeholder tracks the new path.
          pathInput.dispatchEvent(new Event("input"));
        }
      } finally {
        browse.disabled = false;
      }
    });
    pathRow.append(browse);
  }
  if (isLocal) {
    form.append(
      field("Folder path", pathRow, "Where the project lives — agents launch here by default."),
    );
  }

  // --- Default agent ---
  const agentSel = document.createElement("select");
  agentSel.className = "project-modal__input";
  for (const o of AGENT_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = (editing?.defaultAgent ?? "") === o.value;
    agentSel.append(opt);
  }
  form.append(field("Default agent", agentSel, "Pre-selected when you start a session here."));

  // --- Advanced: working-directory override ---
  const advanced = document.createElement("details");
  advanced.className = "project-modal__advanced";
  // Open it if a non-default working dir is already set, so it's not hidden.
  advanced.open = !!editing?.workingDir;
  const summary = document.createElement("summary");
  summary.textContent = "Advanced";
  advanced.append(summary);

  const wdInput = document.createElement("input");
  wdInput.className = "project-modal__input";
  wdInput.value = editing?.workingDir ?? "";
  const syncWdPlaceholder = (): void => {
    wdInput.placeholder = (isLocal ? pathInput.value.trim() : "") || "Defaults to the folder path";
  };
  syncWdPlaceholder();
  pathInput.addEventListener("input", syncWdPlaceholder);
  advanced.append(
    field(
      "Working directory",
      wdInput,
      "Override the cwd agents launch in. Stored now; host honoring is deferred.",
    ),
  );

  // Per-project override of the global "isolate sessions in git worktrees"
  // setting. Inherit (the default) follows the toggle in Settings.
  const isoSel = document.createElement("select");
  isoSel.className = "project-modal__input";
  for (const [value, label] of [
    ["", "Inherit global setting"],
    ["on", "On — per-session worktrees"],
    ["off", "Off — sessions share the checkout"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.selected =
      (editing?.worktreeIsolation === undefined && value === "") ||
      (editing?.worktreeIsolation === true && value === "on") ||
      (editing?.worktreeIsolation === false && value === "off");
    isoSel.append(opt);
  }
  advanced.append(
    field(
      "Session isolation",
      isoSel,
      "Whether sessions of this project run in their own git worktree.",
    ),
  );

  // Per-project override of the global merge-coordinator integration mode.
  const intSel = document.createElement("select");
  intSel.className = "project-modal__input";
  for (const [value, label] of [
    ["", "Inherit global setting"],
    ["fast", "Fast — merge to main + rebuild"],
    ["measured", "Measured — push + open a PR"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.selected = (editing?.integrationMode ?? "") === value;
    intSel.append(opt);
  }
  advanced.append(
    field(
      "Integration mode",
      intSel,
      "How completed sessions of this project are integrated onto trunk.",
    ),
  );

  // The gate + post-merge commands are plain shell — no toolchain assumed. Empty
  // verify = no semantic gate (textual merge only); empty rebuild = none.
  const verifyInput = document.createElement("input");
  verifyInput.className = "project-modal__input";
  verifyInput.value = editing?.integrationVerify ?? "";
  verifyInput.placeholder = "e.g. pnpm -r test · pytest -q · cargo test · make check";
  advanced.append(
    field(
      "Integration verify command",
      verifyInput,
      "Shell command that tests the combined state before integrating. Empty = no gate.",
    ),
  );

  const rebuildInput = document.createElement("input");
  rebuildInput.className = "project-modal__input";
  rebuildInput.value = editing?.integrationRebuild ?? "";
  rebuildInput.placeholder = "e.g. pnpm --filter @orden/web build (optional)";
  advanced.append(
    field(
      "Post-merge rebuild command",
      rebuildInput,
      "Run after a fast merge to main (e.g. rebuild a served bundle). Empty = none.",
    ),
  );
  form.append(advanced);

  // --- Validation message ---
  const error = document.createElement("p");
  error.className = "project-modal__error";
  error.hidden = true;
  form.append(error);

  // --- Actions ---
  const actions = document.createElement("div");
  actions.className = "project-modal__actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "project-modal__btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "project-modal__btn project-modal__btn--primary";
  save.textContent = opts.mode === "create" ? "Add project" : "Save";
  actions.append(cancel, save);
  form.append(actions);

  const showError = (msg: string): void => {
    error.textContent = msg;
    error.hidden = false;
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
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
    const defaultAgent = (agentSel.value || null) as Agent | null;
    const workingDir = wdInput.value.trim() || null;
    const worktreeIsolation = isoSel.value === "" ? null : isoSel.value === "on";
    const integrationMode =
      intSel.value === "" ? null : (intSel.value as "fast" | "measured");
    const integrationVerify = verifyInput.value.trim() || null;
    const integrationRebuild = rebuildInput.value.trim() || null;

    let saved: Project;
    if (opts.mode === "create") {
      saved = addProject(
        name,
        { kind: "local", path },
        { defaultAgent: defaultAgent ?? undefined, workingDir: workingDir ?? undefined },
      );
      if (worktreeIsolation !== null) updateProject(saved.id, { worktreeIsolation });
      if (integrationMode !== null) updateProject(saved.id, { integrationMode });
      if (integrationVerify !== null) updateProject(saved.id, { integrationVerify });
      if (integrationRebuild !== null) updateProject(saved.id, { integrationRebuild });
    } else {
      const id = editing!.id;
      updateProject(id, {
        name,
        path: isLocal ? path : undefined,
        defaultAgent,
        workingDir,
        worktreeIsolation,
        integrationMode,
        integrationVerify,
        integrationRebuild,
      });
      saved = editing!;
    }
    close();
    opts.onSaved?.(saved);
  });

  modal.append(form);
  overlay.append(modal);
  document.body.append(overlay);
  nameInput.focus();
  nameInput.select();
}
