// Read-only code viewer: fixed-width font, highlight.js syntax colouring and a
// line-number gutter. Used for every non-markdown file the user opens (see
// isCodeFile); markdown still goes to the prose/annotation editor.

import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";
import { BLOCK_ID_ATTR, computeBlockId } from "@orden/annotation-core";
import { isCodeFile, languageForPath, splitHighlightedLines } from "./codeHighlight";

export { isCodeFile };

// Highlight `content`, preferring the language inferred from the path and
// falling back to highlight.js auto-detection. Returns hljs HTML (text already
// escaped), or escaped plain text if highlighting throws.
function highlight(path: string, content: string): string {
  const lang = languageForPath(path);
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value;
    }
    return hljs.highlightAuto(content).value;
  } catch {
    const div = document.createElement("div");
    div.textContent = content;
    return div.innerHTML;
  }
}

export function renderCodeView(
  container: HTMLElement,
  doc: { title: string; path: string; content: string },
): HTMLElement {
  container.replaceChildren();
  const lines = splitHighlightedLines(highlight(doc.path, doc.content));
  // A trailing newline yields a final empty line; drop it so the gutter count
  // matches the file's real line count.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const pre = document.createElement("pre");
  pre.className = "code-view";
  const code = document.createElement("code");
  code.className = "hljs";

  for (let n = 0; n < lines.length; n++) {
    const row = document.createElement("div");
    row.className = "code-line";
    const gutter = document.createElement("span");
    gutter.className = "code-gutter";
    gutter.textContent = String(n + 1);
    gutter.setAttribute("aria-hidden", "true");
    const src = document.createElement("span");
    src.className = "code-src";
    // hljs output is escaped + author-controlled span markup, safe to assign.
    src.innerHTML = lines[n] || "​"; // zero-width space keeps blank rows tall
    row.append(gutter, src);
    code.append(row);
  }

  pre.append(code);
  container.append(pre);
  return container;
}

// Tag ONLY the `.code-src` spans with a block id, so each code line's source text
// is its own annotation anchor. Deliberately skips `<pre>`, `.code-line` divs, and
// `.code-gutter` spans — tagging those (as assignBlockIds would) folds the gutter
// line-number into the block's textContent and contaminates selector offsets.
export function assignCodeBlockIds(root: Element): void {
  for (const src of Array.from(root.querySelectorAll(".code-src"))) {
    if (!src.hasAttribute(BLOCK_ID_ATTR)) {
      src.setAttribute(BLOCK_ID_ATTR, computeBlockId(src));
    }
  }
}
