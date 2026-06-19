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

// The editor schema is the standard markdown schema (prose, headings, lists,
// blockquote, code) plus GFM tables and one extra mark: `annotation`. The mark
// carries only an `id`; the annotation body/metadata live in the log, keyed by
// that id. Markdown stays the source of truth, so the mark serializes to nothing
// (no inline ids).
export const schema = new Schema({
  nodes: markdownSchema.spec.nodes.append(tableSpec),
  marks: markdownSchema.spec.marks.addToEnd("annotation", {
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

// A parser bound to our extended schema. We reuse markdown-it (with the GFM
// table rule turned on — it's off in the CommonMark preset) and the default
// token handlers, adding the table tokens. The annotation mark has no markdown
// syntax, so it is dropped on serialize — the document round-trips to markdown.
export const markdownParser = new MarkdownParser(
  schema,
  defaultMarkdownParser.tokenizer.enable("table"),
  {
    ...defaultMarkdownParser.tokens,
    table: { block: "table" },
    tr: { block: "table_row" },
    th: { block: "table_header", getAttrs: (tok) => ({ align: alignOf(tok) }) as Attrs },
    td: { block: "table_cell", getAttrs: (tok) => ({ align: alignOf(tok) }) as Attrs },
    // thead/tbody are structural wrappers with no node of their own.
    thead: { ignore: true },
    tbody: { ignore: true },
  },
);

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
  },
  {
    ...defaultMarkdownSerializer.marks,
    annotation: { open: "", close: "", mixable: true, expelEnclosingWhitespace: true },
  },
);
