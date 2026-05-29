import { pageNames, backlinksTo } from "./pages";

// Renders a table of all pages with their backlink counts; rows open the page.
export function renderPagesIndex(
  container: HTMLElement,
  onOpen: (name: string) => void,
): void {
  container.replaceChildren();

  const heading = document.createElement("h1");
  heading.className = "pages-title";
  heading.textContent = "Pages";
  container.append(heading);

  const names = pageNames();
  if (names.length === 0) {
    const empty = document.createElement("p");
    empty.className = "pages-empty";
    empty.textContent =
      "No pages yet. Create one by typing a [[link]] in the Journal.";
    container.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "pages-table";
  table.innerHTML =
    "<thead><tr><th>Page</th><th>Backlinks</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const name of names) {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    const link = document.createElement("a");
    link.className = "pages-link";
    link.textContent = name;
    link.addEventListener("click", () => onOpen(name));
    nameCell.append(link);
    const countCell = document.createElement("td");
    countCell.className = "pages-count";
    countCell.textContent = String(backlinksTo(name).length);
    tr.append(nameCell, countCell);
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}
