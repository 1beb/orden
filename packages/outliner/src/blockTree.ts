import type { Block } from "./types";

let idCounter = 0;
/** Monotonic, collision-resistant-enough id for in-memory blocks. */
function generateId(): string {
  idCounter += 1;
  return `b${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function createBlock(id: string | undefined, text: string): Block {
  return {
    id: id ?? generateId(),
    text,
    collapsed: false,
    children: [],
  };
}

/**
 * The root is a sentinel block (empty text, fixed id) whose children are the
 * top-level bullets. Keeping a single root simplifies every operation: every
 * real block has a parent.
 */
export function createRoot(children: Block[] = []): Block {
  const root = createBlock("__root__", "");
  root.children = children;
  return root;
}

/** Depth-first search for a block by id. */
export function findBlock(root: Block, id: string): Block | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findBlock(child, id);
    if (found) return found;
  }
  return null;
}

interface Location {
  parent: Block;
  index: number;
}

/** Find a block's parent and its index within that parent's children. */
function locate(root: Block, id: string): Location | null {
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i].id === id) return { parent: root, index: i };
    const deeper = locate(root.children[i], id);
    if (deeper) return deeper;
  }
  return null;
}

/** Nest a block under its previous sibling. No-op if it is the first sibling. */
export function indent(root: Block, id: string): void {
  const loc = locate(root, id);
  if (!loc || loc.index === 0) return;
  const block = loc.parent.children[loc.index];
  const prev = loc.parent.children[loc.index - 1];
  loc.parent.children.splice(loc.index, 1);
  prev.children.push(block);
}

/**
 * Promote a block to be a sibling of its parent, inserted directly after the
 * parent. No-op if the block is already top-level.
 */
export function outdent(root: Block, id: string): void {
  const loc = locate(root, id);
  if (!loc) return;
  const parent = loc.parent;
  if (parent.id === root.id) return; // already top-level
  const grand = locate(root, parent.id);
  if (!grand) return;
  const block = parent.children[loc.index];
  parent.children.splice(loc.index, 1);
  grand.parent.children.splice(grand.index + 1, 0, block);
}

export function moveUp(root: Block, id: string): void {
  const loc = locate(root, id);
  if (!loc || loc.index === 0) return;
  const arr = loc.parent.children;
  [arr[loc.index - 1], arr[loc.index]] = [arr[loc.index], arr[loc.index - 1]];
}

export function moveDown(root: Block, id: string): void {
  const loc = locate(root, id);
  if (!loc || loc.index === loc.parent.children.length - 1) return;
  const arr = loc.parent.children;
  [arr[loc.index + 1], arr[loc.index]] = [arr[loc.index], arr[loc.index + 1]];
}

/**
 * Split a block at a character offset (Enter). The original keeps the head; a
 * new sibling after it gets the tail and inherits the original's children.
 * Returns the new block's id.
 */
export function splitBlock(root: Block, id: string, offset: number): string {
  const loc = locate(root, id);
  if (!loc) throw new Error(`splitBlock: block ${id} not found`);
  const block = loc.parent.children[loc.index];
  const head = block.text.slice(0, offset);
  const tail = block.text.slice(offset);
  const newBlock = createBlock(undefined, tail);
  newBlock.children = block.children;
  block.text = head;
  block.children = [];
  loc.parent.children.splice(loc.index + 1, 0, newBlock);
  return newBlock.id;
}

/**
 * Merge a block into the end of its previous sibling (Backspace at start). The
 * previous sibling absorbs the text and gains the merged block's children.
 * Returns the id the cursor should land on (the previous sibling), or null if
 * there is no previous sibling.
 */
export function mergeWithPrevious(root: Block, id: string): string | null {
  const loc = locate(root, id);
  if (!loc || loc.index === 0) return null;
  const block = loc.parent.children[loc.index];
  const prev = loc.parent.children[loc.index - 1];
  prev.text += block.text;
  prev.children.push(...block.children);
  loc.parent.children.splice(loc.index, 1);
  return prev.id;
}

export function toggleCollapse(root: Block, id: string): void {
  const block = findBlock(root, id);
  if (block) block.collapsed = !block.collapsed;
}
