import { Schema } from "prosemirror-model";
import {
  schema as markdownSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import MarkdownIt from "markdown-it";
import markdownItMark from "markdown-it-mark";
import markdownItGitHubAlerts from "markdown-it-github-alerts";

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

// The editor schema is the standard markdown schema (prose, headings, lists,
// blockquote, code) plus a few extensions:
//   - the `annotation` mark (feedback anchored to a block id; see annotations.ts)
//   - the `highlight` mark (==text==, GFM-ish)
// Markdown stays the source of truth, so each addition round-trips to clean
// markdown and the annotation mark serializes to nothing (no inline ids).
// `list_item` gains a `checked` attr: null = ordinary bullet/number item,
// false/true = a task item rendered with a checkbox.
// GitHub-style alert kinds (> [!NOTE], > [!TIP], …) become an `admonition`
// block carrying a `kind` attr.
const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

const listItemSpec = markdownSchema.spec.nodes.get("list_item")!;
const nodes = markdownSchema.spec.nodes
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

// Our own markdown-it instance, configured exactly like prosemirror-markdown's
// default (CommonMark, no raw HTML) plus the extension plugins. We build our own
// rather than mutate the library's shared default tokenizer.
const tokenizer = MarkdownIt("commonmark", { html: false })
  .use(markdownItMark)
  .use(markdownItGitHubAlerts)
  .use(taskLists);

// A parser bound to our extended schema. We reuse the default token handlers and
// add one per extension. `mark_open`/`mark_close` come from markdown-it-mark; the
// `checked` attr is read from the meta our task-list rule stamps on list items.
export const markdownParser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  mark: { mark: "highlight" },
  list_item: {
    block: "list_item",
    getAttrs: (tok) => ({ checked: tok.meta?.task ? !!tok.meta.checked : null }),
  },
  // `alert_open`/`alert_close` come from markdown-it-github-alerts.
  alert: {
    block: "admonition",
    getAttrs: (tok) => {
      const type = tok.meta?.type;
      return { kind: ALERT_KINDS.includes(type) ? type : "note" };
    },
  },
});

export const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
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
