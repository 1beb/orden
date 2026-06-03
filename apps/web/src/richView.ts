// Viewers for non-code, non-markdown files: images and rendered HTML.
//
// Images load over the host's /repo-file/ byte route (RPC files.read() is utf8
// and would corrupt binary). HTML renders inside a sandboxed iframe via srcdoc:
// allow-scripts WITHOUT allow-same-origin, so the page's own JS runs but in a
// null origin — it can't touch the app's cookies, vault, or localStorage.

export function repoFileUrl(path: string): string {
  return `/repo-file/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function renderImageView(container: HTMLElement, doc: { title: string; path: string }): void {
  container.replaceChildren();
  const img = document.createElement("img");
  img.className = "image-view";
  img.src = repoFileUrl(doc.path);
  img.alt = doc.title;
  container.append(img);
}

// Returns the iframe so callers can hook its `load` event and reach contentDocument
// (owned files render same-origin, so the parent can annotate inside them — Task 8).
export function renderHtmlView(
  container: HTMLElement,
  doc: { title: string; content: string; owned?: boolean },
): HTMLIFrameElement {
  container.replaceChildren();
  const frame = document.createElement("iframe");
  frame.className = "html-view";
  frame.title = doc.title;
  // Owned (on-disk, trusted) HTML renders same-origin so the parent can reach
  // contentDocument to annotate it. External pages stay null-origin: scripts run
  // but with no access to app origin state (cookies, vault, localStorage).
  frame.setAttribute("sandbox", doc.owned ? "allow-scripts allow-same-origin" : "allow-scripts");
  frame.srcdoc = doc.content;
  container.append(frame);
  return frame;
}
