// Viewers for non-code, non-markdown files: images and rendered HTML.
//
// Images load over the host's /repo-file/<projectId>/ byte route (RPC
// files.read() is utf8 and would corrupt binary). HTML renders inside a
// sandboxed iframe via srcdoc: owned (on-disk, trusted) files render
// same-origin so the parent can annotate inside them; external pages stay
// null-origin (allow-scripts only) with no access to app cookies/vault/storage.

export function repoFileUrl(projectId: string, path: string): string {
  return `/repo-file/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// Renders the image wrapped in a positioned container so absolute region-boxes
// can layer over it (Task 9). Returns the wrapper, the <img>, and the overlay
// `layer` the caller paints region boxes into. The layer is pointer-transparent
// (so drag-to-create on empty image works); individual `.region-box` children
// re-enable pointer events to stay clickable (see styles.css).
export function renderImageView(
  container: HTMLElement,
  doc: { title: string; path: string; projectId: string },
): { wrap: HTMLDivElement; img: HTMLImageElement; layer: HTMLDivElement } {
  container.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "image-wrap";
  const img = document.createElement("img");
  img.className = "image-view";
  img.src = repoFileUrl(doc.projectId, doc.path);
  img.alt = doc.title;
  const layer = document.createElement("div");
  layer.className = "region-layer";
  wrap.append(img, layer);
  container.append(wrap);
  return { wrap, img, layer };
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
