import { pagesIndex, backlinksTo, deletePage } from "./pages";

// Format an ISO timestamp as a short, locale-friendly date; "—" when unknown.
function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Renders a table of all pages with their creation date + backlink counts,
// ordered by most recent activity (updated, then created). Rows open the page.
export function renderPagesIndex(
  container: HTMLElement,
  onOpen: (name: string) => void,
): void {
  container.replaceChildren();

  const heading = document.createElement("h1");
  heading.className = "pages-title";
  heading.textContent = "Pages";
  container.append(heading);

  const pages = pagesIndex();
  if (pages.length === 0) {
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
    "<thead><tr><th>Page</th><th>Created</th><th>Backlinks</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const p of pages) {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    const link = document.createElement("a");
    link.className = "pages-link";
    link.textContent = p.name;
    link.addEventListener("click", () => onOpen(p.name));
    nameCell.append(link);

    const createdCell = document.createElement("td");
    createdCell.className = "pages-date";
    createdCell.textContent = fmtDate(p.created);
    if (p.updated && p.updated !== p.created) {
      createdCell.title = `Updated ${fmtDate(p.updated)}`;
    }

    const countCell = document.createElement("td");
    countCell.className = "pages-count";
    countCell.textContent = String(backlinksTo(p.name).length);

    const actionCell = document.createElement("td");
    actionCell.className = "pages-actions";
    const del = document.createElement("button");
    del.className = "pages-del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Delete page";
    del.setAttribute("aria-label", "Delete page");
    del.style.cssText =
      "border:0;background:none;cursor:pointer;color:var(--muted,#999);font-size:0.9em;padding:0 0.25em;line-height:1;opacity:0.6;";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.confirm(`Delete page "${p.name}"? This cannot be undone.`)) {
        deletePage(p.name);
        renderPagesIndex(container, onOpen);
      }
    });
    actionCell.append(del);

    tr.append(nameCell, createdCell, countCell, actionCell);
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}
