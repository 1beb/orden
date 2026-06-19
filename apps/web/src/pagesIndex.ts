import { pagesIndex, backlinkCounts, deletePage } from "./pages";
import { confirmDialog } from "./modal";

// Format an ISO timestamp as a short, locale-friendly date; "—" when unknown.
function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Renders a table of all pages with their creation date + backlink counts,
// ordered by most recent activity (updated, then created). Rows open the page.
export async function renderPagesIndex(
  container: HTMLElement,
  onOpen: (name: string) => void,
): Promise<void> {
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

  // One batched call for every row's badge, keyed by lowercased target. Backlink
  // counts are non-essential enrichment — never let a search/index failure abort
  // the render and leave the Pages nav on an empty page.
  const counts = await backlinkCounts().catch(() => ({}) as Record<string, number>);

  const table = document.createElement("table");
  table.className = "pages-table";
  table.innerHTML =
    '<thead><tr><th>Page</th><th>Created</th><th>Updated</th><th>Backlinks</th><th class="pages-actions"></th></tr></thead>';
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

    const updatedCell = document.createElement("td");
    updatedCell.className = "pages-date";
    updatedCell.textContent = fmtDate(p.updated ?? p.created);

    const countCell = document.createElement("td");
    countCell.className = "pages-count";
    countCell.textContent = String(counts[p.name.toLowerCase()] ?? 0);

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
      void confirmDialog({
        title: "Delete page",
        message: `Delete page "${p.name}"? This cannot be undone.`,
        confirmLabel: "Delete page",
      }).then((ok) => {
        if (!ok) return;
        deletePage(p.name);
        void renderPagesIndex(container, onOpen);
      });
    });
    actionCell.append(del);

    tr.append(nameCell, createdCell, updatedCell, countCell, actionCell);
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
}
