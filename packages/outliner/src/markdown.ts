import type { Block } from "./types";
import { createBlock, createRoot } from "./blockTree";

const INDENT = "  ";
const COLLAPSED_MARKER = "collapsed:: true";

/**
 * Serialize an outline to nested markdown bullets. Collapsed blocks carry a
 * Logseq-style `collapsed:: true` property appended to their text so the flag
 * survives a round-trip through markdown (the source of truth).
 */
export function toMarkdown(root: Block): string {
  const lines: string[] = [];
  const walk = (block: Block, depth: number): void => {
    const pad = INDENT.repeat(depth);
    const text =
      block.collapsed && block.children.length > 0
        ? `${block.text} ${COLLAPSED_MARKER}`
        : block.text;
    lines.push(`${pad}- ${text}`);
    for (const child of block.children) walk(child, depth + 1);
  };
  for (const child of root.children) walk(child, 0);
  return lines.join("\n");
}

interface ParsedLine {
  depth: number;
  text: string;
  collapsed: boolean;
}

const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;

function parseLine(line: string): ParsedLine | null {
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  const indent = m[1].replace(/\t/g, INDENT);
  const depth = Math.floor(indent.length / INDENT.length);
  let text = m[2];
  let collapsed = false;
  if (text.includes(COLLAPSED_MARKER)) {
    collapsed = true;
    text = text.replace(COLLAPSED_MARKER, "").trimEnd();
  }
  return { depth, text, collapsed };
}

/**
 * Parse nested markdown bullets back into a block tree. Indentation depth
 * (two spaces or a tab per level) drives nesting; a `collapsed:: true` marker
 * restores the collapsed flag. Non-bullet and blank lines are ignored.
 */
export function fromMarkdown(md: string): Block {
  const root = createRoot();
  // Stack of [depth, block] tracking the current ancestry.
  const stack: Array<{ depth: number; block: Block }> = [];
  for (const raw of md.split("\n")) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    const block = createBlock(undefined, parsed.text);
    block.collapsed = parsed.collapsed;
    while (stack.length > 0 && stack[stack.length - 1].depth >= parsed.depth) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].block : root;
    parent.children.push(block);
    stack.push({ depth: parsed.depth, block });
  }
  return root;
}
