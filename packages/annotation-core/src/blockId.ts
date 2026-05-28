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
