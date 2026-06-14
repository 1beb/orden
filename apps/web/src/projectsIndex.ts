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
): void {
  container.replaceChildren();

  const heading = document.createElement("h1");
  heading.className = "projects-index-title";
  heading.textContent = "Projects";
  container.append(heading);

  const projects = listProjects();
  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "projects-index-empty";
    empty.textContent = "No projects yet.";
    container.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "projects-index-table";

  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Name</th><th>Source</th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const p of projects) {
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
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}
