interface TextPoint {
  node: Text;
  offset: number;
}

function textNodes(block: Element): Text[] {
  const out: Text[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      out.push(node as Text);
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child);
    }
  };
  visit(block);
  return out;
}

function locate(block: Element, target: number): TextPoint {
  let consumed = 0;
  let last: Text | null = null;
  for (const node of textNodes(block)) {
    const len = node.data.length;
    if (target <= consumed + len) {
      return { node, offset: target - consumed };
    }
    consumed += len;
    last = node;
  }
  if (last) return { node: last, offset: last.data.length };
  throw new Error("block has no text nodes");
}

export function rangeFromOffsets(block: Element, start: number, end: number): Range {
  const a = locate(block, start);
  const b = locate(block, end);
  // block.ownerDocument is non-null for any attached element; an iframe node lives
  // in the iframe's document, so its Range must come from that realm, not global.
  const range = block.ownerDocument!.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

export function offsetsFromRange(block: Element, range: Range): { start: number; end: number } {
  const before = block.ownerDocument!.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}
