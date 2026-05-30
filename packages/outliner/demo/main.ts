import {
  fromMarkdown,
  toMarkdown,
  indent,
  buildBacklinkIndex,
  renderBoard,
  needsActionCount,
  type Card,
} from "../src/index";

// --- Outliner: parse markdown, mutate the tree, render it back to markdown ---
const journalMd = [
  "- Morning planning collapsed:: true",
  "  - Triage [[Project ygqc]] backlog",
  "  - Review yesterday's parked work",
  "- Spin up a session for the panel refactor [[Project panel]]",
  "  - Needs a plan first (no matching skill)",
  "- Read evidence for [[Project ygqc]] writeup",
].join("\n");

const tree = fromMarkdown(journalMd);
// Demonstrate an operation: indent the second top-level bullet under the first.
if (tree.children.length > 1) indent(tree, tree.children[1].id);
document.getElementById("outline")!.textContent = toMarkdown(tree);

// --- Backlinks: index the journal page and show refs to one target ---
const index = buildBacklinkIndex([{ name: "2026-05-28", root: tree }]);
const refs = index["Project ygqc"] ?? [];
const ul = document.getElementById("backlinks")!;
for (const ref of refs) {
  const li = document.createElement("li");
  li.textContent = `${ref.pageName}: ${ref.text}`;
  ul.appendChild(li);
}

// --- Kanban: mock cards derived from sessions ---
const cards: Card[] = [
  { id: "s1", title: "Outliner block-tree model", state: "complete" },
  { id: "s2", title: "Markdown round-trip", state: "complete" },
  { id: "s3", title: "Wiki links + backlinks", state: "complete" },
  { id: "s4", title: "Kanban board view", state: "in-progress" },
  { id: "s5", title: "ProseMirror editor integration", state: "planning" },
  { id: "s6", title: "SFTP file I/O adapter", state: "planning" },
  { id: "s7", title: "Remote tmux session host", state: "blocked" },
  { id: "s8", title: "Transcript adapter (opencode)", state: "blocked" },
];

renderBoard(document.getElementById("board")!, cards);
document.getElementById("nav-badge")!.textContent = String(
  needsActionCount(cards),
);
