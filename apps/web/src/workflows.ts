// The Workflows view: a plain table of workflows (mirrors the Projects index), built
// from the shipped presets in @orden/workflows plus any the operator saved in the vault
// "workflows" namespace as markdown. Clicking a row opens an editable markdown surface —
// a workflow is authored as text, the way the whole system is meant to work.
import type { Host } from "@orden/host-api";
import {
  PRESET_WORKFLOWS,
  parseWorkflowMarkdown,
  type Step,
  type WorkflowSpec,
} from "@orden/workflows";

const NS = "workflows";
const MD_PREFIX = "md:";

let savedMd: Record<string, string> = {}; // name -> markdown source

// View context + sub-view state, set on each onEnter.
let ctx: { container: HTMLElement; host: Host; repaintBreadcrumb: () => void } | null = null;
let editing: { name: string; creating: boolean } | null = null;

// --- data ---------------------------------------------------------------

export async function hydrateWorkflows(h: Host): Promise<void> {
  const keys = await h.vault.list(NS);
  const saved: Record<string, string> = {};
  await Promise.all(
    keys.map(async (k) => {
      if (!k.startsWith(MD_PREFIX)) return;
      const md = await h.vault.get<string>(NS, k);
      if (typeof md === "string") saved[k.slice(MD_PREFIX.length)] = md;
    }),
  );
  savedMd = saved;
}

interface Row {
  name: string;
  description: string;
  source: "preset" | "saved";
}

function presetByName(name: string): WorkflowSpec | undefined {
  return PRESET_WORKFLOWS.find((w) => w.name === name);
}

/** Presets + saved, saved shadowing a preset of the same name. */
export function listWorkflows(): Row[] {
  const byName = new Map<string, Row>();
  for (const w of PRESET_WORKFLOWS) {
    byName.set(w.name, { name: w.name, description: w.description ?? "", source: "preset" });
  }
  for (const [name, md] of Object.entries(savedMd)) {
    const parsed = parseWorkflowMarkdown(md);
    byName.set(name, { name, description: parsed.description ?? "", source: "saved" });
  }
  return [...byName.values()];
}

// --- markdown <-> spec --------------------------------------------------

function stepTag(step: Step): string {
  if (step.kind === "gate") return `gate: ${step.gate}`;
  if (step.kind === "primitive") return `do: ${step.action}`;
  return "prose";
}

/** Render a spec to a readable runbook markdown (used to seed a preset for editing). */
function specToMarkdown(spec: WorkflowSpec): string {
  const out: string[] = ["---", `name: ${spec.name}`];
  if (spec.description) out.push(`description: ${spec.description}`);
  out.push("---", "");
  spec.steps.forEach((step, i) => {
    out.push(`${i + 1}. ${stepTag(step)} — ${step.label}`);
    const prose = "prose" in step ? step.prose : undefined;
    if (prose) out.push(`   ${prose}`);
    out.push("");
  });
  return out.join("\n").trimEnd() + "\n";
}

const NEW_TEMPLATE = `---
name: my-workflow
description: What this workflow is for.
---

1. prose — Plan
   Describe what you want; I plan it and park it for you.

2. gate: approve — Approve the plan
   You approve before I start.

3. prose — Implement
   I do the work on a branch and write up what changed.

4. gate: review — Review
   You read and annotate; I revise.

5. do: push — Publish
   Push the branch and open a PR.
`;

function markdownFor(name: string, creating: boolean): string {
  if (creating) return NEW_TEMPLATE;
  if (savedMd[name] !== undefined) return savedMd[name];
  const preset = presetByName(name);
  return preset ? specToMarkdown(preset) : NEW_TEMPLATE;
}

async function saveMarkdown(h: Host, md: string): Promise<string | null> {
  const name = (parseWorkflowMarkdown(md).name ?? "").trim();
  if (!name || name.includes(":") || name.startsWith("__")) return null;
  savedMd[name] = md;
  await h.vault.set(NS, `${MD_PREFIX}${name}`, md);
  return name;
}

// --- navigation between list and editor ---------------------------------

export function workflowsBreadcrumbName(): string | null {
  if (!editing) return null;
  return editing.creating ? "New workflow" : editing.name;
}

export function workflowsBackToList(): void {
  editing = null;
  draw();
  ctx?.repaintBreadcrumb();
}

function openEditor(name: string, creating: boolean): void {
  editing = { name, creating };
  draw();
  ctx?.repaintBreadcrumb();
}

// --- rendering ----------------------------------------------------------

// A normal inline-sized button (NOT .nav-add, which is a full-width nav pill).
function makeButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText =
    "flex:0 0 auto;width:auto;white-space:nowrap;font:inherit;color:var(--muted);" +
    "background:none;border:1px dashed var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;";
  return b;
}

function renderList(c: { container: HTMLElement }): void {
  const { container } = c;

  // Header row, aligned to the same centered 760px column as the table, with
  // breathing room below the breadcrumb/topbar.
  const header = document.createElement("div");
  header.style.cssText =
    "max-width:760px;margin:1.5rem auto 16px;display:flex;align-items:center;justify-content:space-between;gap:1rem;";
  const heading = document.createElement("h1");
  heading.textContent = "Workflows";
  heading.style.cssText = "margin:0;font-size:calc(22px * var(--font-scale));font-weight:700;";
  const newBtn = makeButton("+ New workflow");
  newBtn.addEventListener("click", () => openEditor("my-workflow", true));
  header.append(heading, newBtn);
  container.append(header);

  const rows = listWorkflows();
  const table = document.createElement("table");
  table.className = "projects-index-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Name</th><th>Description</th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.className = "projects-index-row";
    tr.addEventListener("click", () => openEditor(row.name, false));

    const nameCell = document.createElement("td");
    nameCell.className = "projects-index-name";
    const link = document.createElement("a");
    link.className = "projects-index-link";
    link.textContent = row.name;
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(row.name, false);
    });
    nameCell.append(link);

    const descCell = document.createElement("td");
    descCell.className = "projects-index-source";
    descCell.textContent = row.description;

    tr.append(nameCell, descCell);
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);

  container.append(renderGlossary());
}

const GLOSSARY: { term: string; def: string }[] = [
  {
    term: "Description (intent)",
    def: "What the workflow is for. The agent reads it to suggest the right workflow for a task, and it shows in this list.",
  },
  {
    term: "Prose step",
    def: "Plain instructions to the agent — it does the work (write a plan, implement, analyze). Non-deterministic: the agent interprets it.",
  },
  {
    term: "Gate — approve / review",
    def: "A pause for you. `approve` = sign off on the plan before any work; `review` = read and annotate the result before the workflow advances. Your annotations flow back to the agent.",
  },
  {
    term: "Action (do:)",
    def: "A step orden runs itself, deterministically: push, open-pr, merge, journal, reap, propose-learnings.",
  },
];

function renderGlossary(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "max-width:760px;margin:32px auto 0;padding-top:16px;border-top:1px solid var(--line);";

  const h = document.createElement("h2");
  h.textContent = "Glossary";
  h.style.cssText = "margin:0 0 4px;font-size:calc(13px * var(--font-scale));text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);";
  wrap.append(h);

  const note = document.createElement("p");
  note.textContent =
    "A workflow is a runbook: an ordered list of steps written as markdown. Each step is one of:";
  note.style.cssText = "margin:0 0 10px;font-size:calc(13px * var(--font-scale));color:var(--muted);";
  wrap.append(note);

  const dl = document.createElement("dl");
  dl.style.cssText = "margin:0;display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;";
  for (const { term, def } of GLOSSARY) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    dt.style.cssText = "font-weight:600;font-size:calc(13px * var(--font-scale));";
    const dd = document.createElement("dd");
    dd.textContent = def;
    dd.style.cssText = "margin:0;font-size:calc(13px * var(--font-scale));color:var(--muted);";
    dl.append(dt, dd);
  }
  wrap.append(dl);
  return wrap;
}

function renderEditor(c: { container: HTMLElement; host: Host }, name: string, creating: boolean): void {
  const { container, host } = c;

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "max-width:760px;margin:0 auto;padding:0 0 1.25rem;display:flex;flex-direction:column;gap:0.75rem;box-sizing:border-box;";

  const ta = document.createElement("textarea");
  ta.value = markdownFor(name, creating);
  ta.spellcheck = false;
  ta.style.cssText =
    "flex:1;min-height:60vh;width:100%;box-sizing:border-box;padding:0.9rem 1rem;" +
    "font-family:var(--mono,ui-monospace,Menlo,monospace);font-size:13px;line-height:1.55;" +
    "border:1px solid var(--border,#3334);border-radius:8px;background:var(--panel,#0001);" +
    "color:inherit;resize:vertical;";

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:0.5rem;align-items:center;";
  const save = makeButton("Save");
  const err = document.createElement("span");
  err.style.cssText = "color:#dc2626;font-size:12px;align-self:center;";
  save.addEventListener("click", async () => {
    const savedName = await saveMarkdown(host, ta.value);
    if (!savedName) {
      err.textContent = "Needs a `name:` in the frontmatter (no ':' or leading '__').";
      return;
    }
    workflowsBackToList();
  });
  const cancel = makeButton("Back");
  cancel.addEventListener("click", () => workflowsBackToList());

  bar.append(save, cancel, err);
  wrap.append(ta, bar);
  container.append(wrap);
}

function draw(): void {
  if (!ctx) return;
  ctx.container.replaceChildren();
  if (editing) renderEditor(ctx, editing.name, editing.creating);
  else renderList(ctx);
}

/** onEnter for the Workflows view. Always opens on the list. */
export function renderWorkflowsView(
  container: HTMLElement,
  host: Host,
  repaintBreadcrumb: () => void,
): void {
  ctx = { container, host, repaintBreadcrumb };
  editing = null;
  draw();
}
