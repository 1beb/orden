// Viewers for non-code, non-markdown files: images and rendered HTML.
//
// Images load over the host's /repo-file/ byte route (RPC files.read() is utf8
// and would corrupt binary). HTML renders inside a sandboxed iframe via srcdoc:
// allow-scripts WITHOUT allow-same-origin, so the page's own JS runs but in a
// null origin — it can't touch the app's cookies, vault, or localStorage.

export function repoFileUrl(projectId: string, path: string): string {
  return `/repo-file/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function renderImageView(
  container: HTMLElement,
  doc: { title: string; path: string; projectId: string },
): void {
  container.replaceChildren();
  const img = document.createElement("img");
  img.className = "image-view";
  img.src = repoFileUrl(doc.projectId, doc.path);
  img.alt = doc.title;
  container.append(img);
}

export function renderHtmlView(
  container: HTMLElement,
  doc: { title: string; content: string },
): void {
  container.replaceChildren();
  const frame = document.createElement("iframe");
  frame.className = "html-view";
  frame.title = doc.title;
  // null-origin sandbox: scripts run, but with no access to app origin state.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = doc.content;
  container.append(frame);
}
