import { Schema } from "prosemirror-model";
import {
  schema as markdownSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import { tableNodes } from "prosemirror-tables";
import type { Node as PMNode, Attrs } from "prosemirror-model";
import MarkdownIt from "markdown-it";
import markdownItMark from "markdown-it-mark";
import markdownItGitHubAlerts from "markdown-it-github-alerts";

// GFM table cells hold a single line of inline content (faithful to markdown —
// no block content in cells, so the doc always round-trips to clean pipes). The
// `align` attribute carries the per-column left/center/right from the delimiter
// row and renders as a `text-align` style.
type Align = "left" | "center" | "right" | null;

const tableSpec = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM(dom) {
        return ((dom as HTMLElement).style.textAlign as Align) || null;
      },
      setDOMAttr(value, attrs) {
        if (value) attrs.style = `${(attrs.style as string) ?? ""}text-align: ${value};`;
      },
    },
  },
});

// Matches a GFM task-list marker at the very start of an item: "[ ] ", "[x] ".
const TASK_MARKER = /^\[([ xX])\]\s+/;

// A no-HTML task-list rule. markdown-it-task-lists injects an <input> as an
// `html_inline` token, which the ProseMirror parser can't consume. Instead we
// tag the `list_item_open` token with the checked state and strip the marker
// text, so a task item is just a `list_item` carrying a `checked` attr.
function taskLists(md: MarkdownIt): void {
  md.core.ruler.after("inline", "orden-task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== "inline") continue;
      const para = tokens[i - 1];
      const item = tokens[i - 2];
      if (!para || para.type !== "paragraph_open") continue;
      if (!item || item.type !== "list_item_open") continue;
      const m = TASK_MARKER.exec(inline.content);
      if (!m) continue;
      item.meta = { ...(item.meta || {}), task: true, checked: m[1].toLowerCase() === "x" };
      inline.content = inline.content.slice(m[0].length);
      const first = inline.children && inline.children[0];
      if (first && first.type === "text") first.content = first.content.slice(m[0].length);
    }
  });
}

// GitHub-style alert kinds (> [!NOTE], > [!TIP], …) become an `admonition`
// block carrying a `kind` attr.
const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

// `list_item` gains a `checked` attr: null = ordinary bullet/number item,
// false/true = a task item rendered with a checkbox.
const listItemSpec = markdownSchema.spec.nodes.get("list_item")!;
const nodes = markdownSchema.spec.nodes
  .append(tableSpec)
  .update("list_item", {
    ...listItemSpec,
    attrs: { checked: { default: null } },
    parseDOM: [
      {
        tag: "li[data-checked]",
        getAttrs: (dom) => ({ checked: (dom as HTMLElement).getAttribute("data-checked") === "true" }),
      },
      { tag: "li", getAttrs: () => ({ checked: null }) },
    ],
    toDOM(node) {
      if (node.attrs.checked === null) return ["li", 0];
      return [
        "li",
        { class: "task-list-item", "data-checked": node.attrs.checked ? "true" : "false" },
        [
          "input",
          { type: "checkbox", contenteditable: "false", ...(node.attrs.checked ? { checked: "checked" } : {}) },
        ],
        ["div", { class: "task-list-item-body" }, 0],
      ];
    },
  })
  .addToEnd("admonition", {
    content: "block+",
    group: "block",
    defining: true,
    attrs: { kind: { default: "note" } },
    parseDOM: [
      {
        tag: "div.markdown-alert",
        getAttrs: (dom) => {
          const m = /markdown-alert-(\w+)/.exec((dom as HTMLElement).className);
          return { kind: m ? m[1] : "note" };
        },
      },
    ],
    toDOM(node) {
      const kind = String(node.attrs.kind);
      const title = kind.charAt(0).toUpperCase() + kind.slice(1);
      return [
        "div",
        { class: `markdown-alert markdown-alert-${kind}` },
        ["p", { class: "markdown-alert-title" }, title],
        ["div", { class: "markdown-alert-body" }, 0],
      ];
    },
  });

// The editor schema is the standard markdown schema (prose, headings, lists,
// blockquote, code) plus several extensions:
//   - GFM tables (prosemirror-tables)
//   - task-list items (a `checked` attr on `list_item`)
//   - callout/admonition blocks (> [!NOTE] …)
//   - the `highlight` mark (==text==)
//   - the `annotation` mark (feedback anchored to a block id; see annotations.ts)
// Markdown stays the source of truth, so each addition round-trips to clean
// markdown and the annotation mark serializes to nothing (no inline ids).
export const schema = new Schema({
  nodes,
  marks: markdownSchema.spec.marks
    .addToEnd("highlight", {
      parseDOM: [{ tag: "mark" }],
      toDOM() {
        return ["mark", 0];
      },
    })
    .addToEnd("annotation", {
      attrs: { id: {}, target: { default: "agent" } },
      inclusive: false,
      parseDOM: [
        {
          tag: "span.annotation",
          getAttrs: (dom) => ({
            id: (dom as HTMLElement).getAttribute("data-annotation-id"),
            target: (dom as HTMLElement).getAttribute("data-target") ?? "agent",
          }),
        },
      ],
      toDOM(mark) {
        return [
          "span",
          {
            class: "annotation",
            "data-annotation-id": mark.attrs.id as string,
            "data-target": mark.attrs.target as string,
          },
          0,
        ];
      },
    }),
});

// markdown-it tags an aligned column's cells with a `text-align:` style on the
// th/td token. Pull that back into the `align` attribute (left columns carry no
// style, so they stay null).
function alignOf(tok: { attrGet?: (name: string) => string | null }): Align {
  const style = tok.attrGet ? tok.attrGet("style") : null;
  const m = style ? /text-align:\s*(left|right|center)/.exec(style) : null;
  return (m?.[1] as Align) ?? null;
}

// Our own markdown-it instance, configured like prosemirror-markdown's default
// (CommonMark, no raw HTML) but with the GFM table rule re-enabled (off in the
// CommonMark preset) and the extension plugins. We build our own rather than
// mutate the library's shared default tokenizer.
const tokenizer = MarkdownIt("commonmark", { html: false })
  .enable("table")
  .use(markdownItMark)
  .use(markdownItGitHubAlerts)
  .use(taskLists);

// A parser bound to our extended schema. We reuse the default token handlers and
// add one per extension: GFM table tokens; `mark_open`/`mark_close` from
// markdown-it-mark; the `checked` attr from the meta our task-list rule stamps on
// list items; and `alert_open`/`alert_close` from markdown-it-github-alerts.
export const markdownParser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  table: { block: "table" },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok) => ({ align: alignOf(tok) }) as Attrs },
  td: { block: "table_cell", getAttrs: (tok) => ({ align: alignOf(tok) }) as Attrs },
  // thead/tbody are structural wrappers with no node of their own.
  thead: { ignore: true },
  tbody: { ignore: true },
  mark: { mark: "highlight" },
  list_item: {
    block: "list_item",
    getAttrs: (tok) => ({ checked: tok.meta?.task ? !!tok.meta.checked : null }),
  },
  alert: {
    block: "admonition",
    getAttrs: (tok) => {
      const type = tok.meta?.type;
      return { kind: ALERT_KINDS.includes(type) ? type : "note" };
    },
  },
});

const ALIGN_DELIM: Record<string, string> = {
  left: ":---",
  center: ":---:",
  right: "---:",
};

// Render a cell's inline content to a markdown string by capturing the
// serializer's output buffer, then make it table-safe (pipes escaped, no
// newlines).
function renderCell(state: MarkdownSerializerState, cell: PMNode): string {
  // `out` is the serializer's accumulator buffer; it's real at runtime but not in
  // the public types. Swap it to capture just this cell's inline rendering.
  const buf = state as unknown as { out: string };
  const saved = buf.out;
  buf.out = "";
  state.renderInline(cell);
  const text = buf.out;
  buf.out = saved;
  return text.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
}

function serializeTable(state: MarkdownSerializerState, node: PMNode): void {
  const rows: PMNode[][] = [];
  node.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => cells.push(cell));
    rows.push(cells);
  });
  if (rows.length === 0) {
    state.closeBlock(node);
    return;
  }
  const aligns = rows[0].map((c) => c.attrs.align as Align);
  const line = (cells: PMNode[]) =>
    `| ${cells.map((c) => renderCell(state, c)).join(" | ")} |`;
  const delim = `| ${aligns.map((a) => (a ? ALIGN_DELIM[a] : "---")).join(" | ")} |`;

  state.write(line(rows[0]));
  state.ensureNewLine();
  state.write(delim);
  for (let i = 1; i < rows.length; i++) {
    state.ensureNewLine();
    state.write(line(rows[i]));
  }
  state.closeBlock(node);
}

export const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    table: serializeTable,
    // Prefix task items with their checkbox marker; ordinary items are unchanged.
    list_item(state, node) {
      if (node.attrs.checked !== null) state.write(node.attrs.checked ? "[x] " : "[ ] ");
      state.renderContent(node);
    },
    // Serialize back to a GitHub alert: a blockquote whose first line is [!KIND].
    admonition(state, node) {
      state.wrapBlock("> ", null, node, () => {
        state.write(`[!${String(node.attrs.kind).toUpperCase()}]`);
        state.ensureNewLine();
        state.renderContent(node);
      });
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    // The annotation mark has no markdown syntax, so it is dropped on serialize.
    annotation: { open: "", close: "", mixable: true, expelEnclosingWhitespace: true },
    highlight: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
  },
);
