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

// Inject a <base href> into an HTML document's <head> so relative resource links
// (Quarto/Pandoc emit `<link href="x_files/libs/…">`, `<script src>`, `<img>`)
// resolve against the file's own directory. A srcdoc iframe otherwise inherits the
// PARENT app's URL as its base, so every relative link 404s and the page renders
// with only its inline <style> — losing its theme CSS. The base must precede the
// first relative link, so it goes right after the <head> open tag (or, lacking a
// head, at the very front). The href is a same-origin /repo-file/ url built from
// pre-encoded segments, so it carries no `"`/`<`; escape defensively regardless.
function injectBaseHref(html: string, baseHref: string): string {
  const tag = `<base href="${baseHref.replace(/&/g, "&amp;").replace(/"/g, "%22")}">`;
  const headOpen = /<head[^>]*>/i;
  return headOpen.test(html) ? html.replace(headOpen, (m) => m + tag) : tag + html;
}

// Returns the iframe so callers can hook its `load` event and reach contentDocument
// (owned files render same-origin, so the parent can annotate inside them — Task 8).
// `baseHref` (owned files only) is the /repo-file/ url of the doc's directory so its
// relative CSS/JS/image links load; see injectBaseHref.
export function renderHtmlView(
  container: HTMLElement,
  doc: { title: string; content: string; owned?: boolean; baseHref?: string },
): HTMLIFrameElement {
  container.replaceChildren();
  const frame = document.createElement("iframe");
  frame.className = "html-view";
  frame.title = doc.title;
  // Owned (on-disk, trusted) HTML renders same-origin so the parent can reach
  // contentDocument to annotate it. External pages stay null-origin: scripts run
  // but with no access to app origin state (cookies, vault, localStorage).
  frame.setAttribute("sandbox", doc.owned ? "allow-scripts allow-same-origin" : "allow-scripts");
  frame.srcdoc = doc.baseHref ? injectBaseHref(doc.content, doc.baseHref) : doc.content;
  container.append(frame);
  return frame;
}
