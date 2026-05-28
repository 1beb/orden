function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function structuralPath(el: Element): string {
  const parts: string[] = [];
  let node: Element = el;
  while (node.parentElement) {
    const parent: Element = node.parentElement;
    const index = Array.from(parent.children).indexOf(node);
    parts.push(`${node.tagName}:${index}`);
    node = parent;
  }
  return parts.reverse().join("/");
}

export function computeBlockId(el: Element): string {
  const text = (el.textContent ?? "").trim();
  return fnv1a(`${structuralPath(el)}|${text}`);
}

export const BLOCK_ID_ATTR = "data-orden-block-id";

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6",
  "LI", "UL", "OL", "BLOCKQUOTE", "PRE",
  "TABLE", "TR", "TD", "TH", "FIGURE", "DIV",
]);

export function assignBlockIds(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (BLOCK_TAGS.has(node.tagName) && !node.hasAttribute(BLOCK_ID_ATTR)) {
      node.setAttribute(BLOCK_ID_ATTR, computeBlockId(node));
    }
    node = walker.nextNode() as Element | null;
  }
}
