import { listProjects, type Project } from "./projects";

function sourceLabel(p: Project): string {
  switch (p.source.kind) {
    case "local":
      return p.source.path;
    case "ssh":
      return `${p.source.host}:${p.source.path}`;
    case "s3":
      return `s3://${p.source.bucket}`;
    case "ephemeral":
      return "Ephemeral";
  }
}

export function renderProjectsIndex(
  container: HTMLElement,
  onOpen: (projectId: string) => void,
  onUnarchive?: (projectId: string) => void,
): void {
  container.replaceChildren();

  const heading = document.createElement("h1");
  heading.className = "projects-index-title";
  heading.textContent = "Projects";
  container.append(heading);

  const active = listProjects();
  const archived = listProjects({ includeArchived: true }).filter((p) => p.archived);

  if (active.length === 0 && archived.length === 0) {
    const empty = document.createElement("p");
    empty.className = "projects-index-empty";
    empty.textContent = "No projects yet.";
    container.append(empty);
    return;
  }

  if (active.length > 0) {
    container.append(projectsTable(active, onOpen));
  } else {
    const none = document.createElement("p");
    none.className = "projects-index-empty";
    none.textContent = "No active projects.";
    container.append(none);
  }

  if (archived.length > 0) {
    container.append(archivedSection(archived, onOpen, onUnarchive));
  }
}

// The active-projects table: Name | Source, each row opens the project.
function projectsTable(
  projects: Project[],
  onOpen: (projectId: string) => void,
): HTMLElement {
  const table = document.createElement("table");
  table.className = "projects-index-table";

  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Name</th><th>Source</th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const p of projects) {
    tbody.append(projectRow(p, onOpen));
  }
  table.append(tbody);
  return table;
}

// A single clickable project row (Name | Source). Shared by the active table
// and the archived list — the archived list appends an Unarchive action cell.
function projectRow(
  p: Project,
  onOpen: (projectId: string) => void,
  extraCell?: HTMLElement,
): HTMLElement {
  const tr = document.createElement("tr");
  tr.className = "projects-index-row";
  tr.addEventListener("click", () => onOpen(p.id));

  const nameCell = document.createElement("td");
  nameCell.className = "projects-index-name";
  const nameLink = document.createElement("a");
  nameLink.className = "projects-index-link";
  nameLink.textContent = p.name;
  nameLink.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpen(p.id);
  });
  nameCell.append(nameLink);

  const sourceCell = document.createElement("td");
  sourceCell.className = "projects-index-source";
  sourceCell.textContent = sourceLabel(p);

  tr.append(nameCell, sourceCell);
  if (extraCell) tr.append(extraCell);
  return tr;
}

// The archived projects, in a furled <details> (closed by default) so they stay
// out of the way but remain findable. Each row carries an Unarchive button; the
// row still opens the project on click.
function archivedSection(
  projects: Project[],
  onOpen: (projectId: string) => void,
  onUnarchive?: (projectId: string) => void,
): HTMLElement {
  const details = document.createElement("details");
  details.className = "projects-index-archived";
  const summary = document.createElement("summary");
  summary.className = "projects-index-archived-head";
  summary.textContent = `Archived (${projects.length})`;
  details.append(summary);

  const table = document.createElement("table");
  table.className = "projects-index-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Name</th><th>Source</th><th></th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const p of projects) {
    const actionCell = document.createElement("td");
    actionCell.className = "projects-index-action";
    if (onUnarchive) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "projects-index-unarchive";
      btn.textContent = "Unarchive";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onUnarchive(p.id);
      });
      actionCell.append(btn);
    }
    tbody.append(projectRow(p, onOpen, actionCell));
  }
  table.append(tbody);
  details.append(table);
  return details;
}
