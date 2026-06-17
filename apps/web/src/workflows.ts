// The Workflows view: a browseable library of runbooks the operator can apply, built
// from the shipped presets in @orden/workflows plus any saved in the vault "workflows"
// namespace. "Apply" marks a workflow the global default (vault key "__default");
// "New workflow" creates a saved workflow that extends the default, which the operator
// later fleshes out with an agent (the workflow_* MCP capability, Stage 3).
import type { Host } from "@orden/host-api";
import {
  PRESET_WORKFLOWS,
  resolveSpec,
  validateWorkflow,
  type Step,
  type WorkflowSpec,
} from "@orden/workflows";

const NS = "workflows";
const DEFAULT_KEY = "__default";

let savedCache: Record<string, WorkflowSpec> = {};
let defaultName = "default";
let composing = false;

/** Keys that are control entries, not stored workflow specs. */
function isSpecKey(key: string): boolean {
  return key !== DEFAULT_KEY && !key.startsWith("project:") && !key.startsWith("__");
}

export async function hydrateWorkflows(h: Host): Promise<void> {
  const keys = await h.vault.list(NS);
  const saved: Record<string, WorkflowSpec> = {};
  await Promise.all(
    keys.map(async (k) => {
      if (k === DEFAULT_KEY) {
        const d = await h.vault.get<string>(NS, DEFAULT_KEY);
        if (typeof d === "string") defaultName = d;
        return;
      }
      if (!isSpecKey(k)) return;
      const spec = await h.vault.get<WorkflowSpec>(NS, k);
      if (spec && Array.isArray(spec.steps)) saved[spec.name] = spec;
    }),
  );
  savedCache = saved;
}

interface Listed {
  spec: WorkflowSpec;
  source: "preset" | "saved";
}

/** Presets + saved, saved shadowing a preset of the same name. */
export function listWorkflows(): Listed[] {
  const byName = new Map<string, Listed>();
  for (const spec of PRESET_WORKFLOWS) byName.set(spec.name, { spec, source: "preset" });
  for (const spec of Object.values(savedCache)) byName.set(spec.name, { spec, source: "saved" });
  return [...byName.values()];
}

async function applyWorkflow(h: Host, name: string): Promise<void> {
  defaultName = name;
  await h.vault.set(NS, DEFAULT_KEY, name);
}

async function createWorkflow(h: Host, name: string, description: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("__") || trimmed.includes(":")) return false;
  if (listWorkflows().some((w) => w.spec.name === trimmed)) return false;
  const spec = resolveSpec({ name: trimmed, description: description.trim() || undefined });
  savedCache[trimmed] = spec;
  await h.vault.set(NS, trimmed, spec);
  return true;
}

// --- rendering ----------------------------------------------------------

const ROLE_COLOR: Record<string, string> = {
  initial: "#6d28d9",
  active: "#059669",
  waiting: "#d97706",
  terminal: "#2563eb",
};

function stepTag(step: Step): string {
  if (step.kind === "gate") return `gate · ${step.gate}`;
  if (step.kind === "primitive") return `do · ${step.action}`;
  return "prose";
}

function renderStep(step: Step): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px;";
  const dot = document.createElement("span");
  dot.style.cssText = `flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:${ROLE_COLOR[step.role] ?? "#888"};`;
  const tag = document.createElement("code");
  tag.textContent = stepTag(step);
  tag.style.cssText =
    "flex:0 0 auto;font-size:11px;opacity:.8;min-width:96px;display:inline-block;";
  const label = document.createElement("span");
  label.textContent = step.label;
  row.append(dot, tag, label);
  return row;
}

function renderCard(h: Host, listed: Listed, rerender: () => void): HTMLElement {
  const { spec, source } = listed;
  const card = document.createElement("div");
  card.style.cssText =
    "border:1px solid var(--border,#3334);border-radius:10px;padding:14px 16px;margin:0 0 14px;background:var(--panel,#0001);";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px;";
  const name = document.createElement("strong");
  name.textContent = spec.name;
  name.style.fontSize = "15px";
  head.append(name);

  const badge = (text: string, bg: string) => {
    const b = document.createElement("span");
    b.textContent = text;
    b.style.cssText = `font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:6px;background:${bg};color:#fff;`;
    return b;
  };
  head.append(badge(source, source === "preset" ? "#475569" : "#7c3aed"));
  const isDefault = spec.name === defaultName;
  if (isDefault) head.append(badge("applied", "#059669"));

  const { warnings } = validateWorkflow(spec);
  if (warnings.length > 0) {
    const w = badge(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`, "#d97706");
    w.title = warnings.join("\n");
    head.append(w);
  }
  card.append(head);

  if (spec.description) {
    const desc = document.createElement("div");
    desc.textContent = spec.description;
    desc.style.cssText = "opacity:.75;font-size:13px;margin-bottom:10px;";
    card.append(desc);
  }

  const steps = document.createElement("div");
  steps.style.cssText = "margin-bottom:12px;";
  for (const step of spec.steps) steps.append(renderStep(step));
  card.append(steps);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;";
  const apply = document.createElement("button");
  apply.className = "nav-add";
  apply.textContent = isDefault ? "Applied" : "Apply";
  apply.disabled = isDefault;
  apply.addEventListener("click", async () => {
    await applyWorkflow(h, spec.name);
    rerender();
  });
  actions.append(apply);
  card.append(actions);

  return card;
}

function renderComposer(h: Host, rerender: () => void): HTMLElement {
  const form = document.createElement("div");
  form.style.cssText =
    "border:1px dashed var(--border,#3338);border-radius:10px;padding:14px 16px;margin:0 0 16px;display:flex;flex-direction:column;gap:8px;max-width:520px;";
  const nameIn = document.createElement("input");
  nameIn.placeholder = "Workflow name (e.g. hotfix)";
  nameIn.style.cssText = "padding:6px 8px;font-size:14px;";
  const descIn = document.createElement("input");
  descIn.placeholder = "What is it for? (shown to the agent + in the picker)";
  descIn.style.cssText = "padding:6px 8px;font-size:14px;";
  const err = document.createElement("div");
  err.style.cssText = "color:#dc2626;font-size:12px;min-height:14px;";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;";
  const create = document.createElement("button");
  create.className = "nav-add";
  create.textContent = "Create";
  create.addEventListener("click", async () => {
    const ok = await createWorkflow(h, nameIn.value, descIn.value);
    if (!ok) {
      err.textContent = "Name must be unique, non-empty, and contain no ':' or leading '__'.";
      return;
    }
    composing = false;
    rerender();
  });
  const cancel = document.createElement("button");
  cancel.className = "nav-add";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    composing = false;
    rerender();
  });
  row.append(create, cancel);
  form.append(nameIn, descIn, err, row);
  return form;
}

export function renderWorkflowsIndex(container: HTMLElement, h: Host): void {
  const rerender = () => renderWorkflowsIndex(container, h);
  container.replaceChildren();

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";
  const heading = document.createElement("h1");
  heading.textContent = "Workflows";
  heading.style.margin = "0";
  const newBtn = document.createElement("button");
  newBtn.className = "nav-add";
  newBtn.id = "add-workflow";
  newBtn.textContent = "+ New workflow";
  newBtn.addEventListener("click", () => {
    composing = !composing;
    rerender();
  });
  header.append(heading, newBtn);
  container.append(header);

  const sub = document.createElement("p");
  sub.textContent =
    "Pick a workflow to apply as the default, or create your own. The applied workflow is the one the agent suggests and runs.";
  sub.style.cssText = "opacity:.7;font-size:13px;margin:0 0 16px;";
  container.append(sub);

  if (composing) container.append(renderComposer(h, rerender));

  for (const listed of listWorkflows()) container.append(renderCard(h, listed, rerender));
}
