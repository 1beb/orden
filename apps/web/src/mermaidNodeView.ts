// Live-renders ```mermaid code blocks in the outliner. The block stays a plain
// `code_block` (params = "mermaid"), so markdown round-trips losslessly; this
// only adds a rendered <svg> preview above the still-editable source. mermaid is
// a heavy dependency, so it is dynamically imported on first render.
import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";

// A code block whose fence info string is `mermaid` (allowing `mermaid {init}`).
export function isMermaidBlock(node: PMNode): boolean {
  return node.type.name === "code_block" && /^mermaid\b/.test(String(node.attrs.params || ""));
}

// The synchronous DOM scaffold: a rendered preview (not editable) over the
// editable source `<code>` (the NodeView's contentDOM). Pure, so it is testable
// without loading mermaid.
export function buildMermaidDom(): {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  preview: HTMLElement;
} {
  const dom = document.createElement("div");
  dom.className = "mermaid-block";
  const preview = document.createElement("div");
  preview.className = "mermaid-render";
  preview.setAttribute("contenteditable", "false");
  const pre = document.createElement("pre");
  pre.className = "mermaid-source";
  const code = document.createElement("code");
  pre.appendChild(code);
  dom.appendChild(preview);
  dom.appendChild(pre);
  return { dom, contentDOM: code, preview };
}

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      return m.default;
    });
  }
  return mermaidPromise;
}

let seq = 0;
// Render `source` into `preview`. Errors (invalid diagram syntax) render as text
// rather than throwing, so a half-typed diagram never breaks the editor.
export async function renderMermaid(preview: HTMLElement, source: string): Promise<void> {
  const text = source.trim();
  if (!text) {
    preview.innerHTML = "";
    preview.classList.remove("mermaid-error");
    return;
  }
  try {
    const mermaid = await getMermaid();
    const { svg } = await mermaid.render(`orden-mermaid-${++seq}`, text);
    preview.innerHTML = svg;
    preview.classList.remove("mermaid-error");
  } catch (err) {
    preview.textContent = `Mermaid error: ${(err as Error)?.message ?? String(err)}`;
    preview.classList.add("mermaid-error");
  }
}

// ProseMirror NodeView for mermaid code blocks. Keeps the source editable and
// re-renders the diagram (debounced) as it changes.
export class MermaidNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private preview: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(node: PMNode) {
    const built = buildMermaidDom();
    this.dom = built.dom;
    this.contentDOM = built.contentDOM;
    this.preview = built.preview;
    void renderMermaid(this.preview, node.textContent);
  }

  private schedule(node: PMNode) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void renderMermaid(this.preview, node.textContent), 300);
  }

  update(node: PMNode): boolean {
    if (!isMermaidBlock(node)) return false;
    this.schedule(node);
    return true;
  }

  // The preview is generated, not part of the document; ignore its mutations.
  ignoreMutation(m: MutationRecord | { target: Node }): boolean {
    return this.preview.contains(m.target as Node);
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
  }
}
