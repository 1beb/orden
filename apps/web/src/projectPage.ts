import { LIFECYCLE_ORDER, type CardState } from "@orden/outliner";
import { itemsByProject, addItem, setItemState } from "./cards";
import { getProject } from "./projects";

const STATES: CardState[] = [...LIFECYCLE_ORDER, "broken"];

// A project's page: a simple issue tracker — items grouped into collapsible
// sections by state, plus an add-item box. (AI sessions per item come later.)
export function renderProjectPage(
  container: HTMLElement,
  projectId: string,
  onChange: () => void,
): void {
  const project = getProject(projectId);
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

  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent =
    project.source.kind === "local"
      ? project.source.path
      : project.source.kind === "ephemeral"
        ? "ephemeral project"
        : project.source.kind;

  const addRow = document.createElement("div");
  addRow.className = "project-add";
  const input = document.createElement("input");
  input.className = "project-add-input";
  input.placeholder = "Add an item…";
  const addBtn = document.createElement("button");
  addBtn.className = "project-add-btn";
  addBtn.textContent = "Add";
  const commit = () => {
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

  const list = document.createElement("div");
  list.className = "issue-list";

  container.append(heading, meta, addRow, list);

  function render(): void {
    const items = itemsByProject(projectId);
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "pages-empty";
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
      summary.innerHTML = `<span class="issue-group-state" data-state="${state}">${state}</span> <span class="issue-group-count">${group.length}</span>`;
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
          opt.textContent = s;
          opt.selected = s === item.state;
          select.append(opt);
        }
        select.addEventListener("change", () => {
          setItemState(item.id, select.value as CardState);
          onChange();
          render();
        });
        row.append(title, select);
        details.append(row);
      }
      list.append(details);
    }
  }

  render();
}
