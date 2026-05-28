import { Schema } from "prosemirror-model";
import {
  schema as markdownSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";

// The editor schema is the standard markdown schema (prose, headings, lists,
// blockquote, code) plus one extra mark: `annotation`. The mark carries only an
// `id`; the annotation body/metadata live in the log, keyed by that id. Markdown
// stays the source of truth, so the mark serializes to nothing (no inline ids).
export const schema = new Schema({
  nodes: markdownSchema.spec.nodes,
  marks: markdownSchema.spec.marks.addToEnd("annotation", {
    attrs: { id: {} },
    inclusive: false,
    parseDOM: [
      {
        tag: "span.annotation",
        getAttrs: (dom) => ({
          id: (dom as HTMLElement).getAttribute("data-annotation-id"),
        }),
      },
    ],
    toDOM(mark) {
      return [
        "span",
        { class: "annotation", "data-annotation-id": mark.attrs.id as string },
        0,
      ];
    },
  }),
});

// A parser/serializer bound to our extended schema. We reuse markdown-it and the
// default token handlers; the annotation mark has no markdown syntax, so it is
// dropped on serialize — the document round-trips to clean markdown.
export const markdownParser = new MarkdownParser(
  schema,
  defaultMarkdownParser.tokenizer,
  defaultMarkdownParser.tokens,
);

export const markdownSerializer = new MarkdownSerializer(
  defaultMarkdownSerializer.nodes,
  {
    ...defaultMarkdownSerializer.marks,
    annotation: { open: "", close: "", mixable: true, expelEnclosingWhitespace: true },
  },
);
