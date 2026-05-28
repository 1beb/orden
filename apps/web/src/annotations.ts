import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { createAnnotation, type Annotation } from "@orden/annotation-core";
import { schema } from "./schema";
import type { AnnotationLog } from "./store";

const QUOTE_CONTEXT = 32;

// One annotation as it currently sits in the document: its id and live range.
export interface PlacedAnnotation {
  id: string;
  from: number;
  to: number;
  text: string;
}

// Apply an annotation mark to the current selection and log a record keyed by the
// same id. The mark is the live anchor (ProseMirror tracks its position); the log
// holds the content. Returns the new record, or null if the selection is empty.
export function addAnnotation(
  view: EditorView,
  log: AnnotationLog,
  body: string,
  target: "agent" | "human" = "agent",
): Annotation | null {
  const { from, to } = view.state.selection;
  if (from >= to) return null;

  const doc = view.state.doc;
  const exact = doc.textBetween(from, to);
  const prefix = doc.textBetween(Math.max(0, from - QUOTE_CONTEXT), from, " ", " ");
  const suffix = doc.textBetween(
    to,
    Math.min(doc.content.size, to + QUOTE_CONTEXT),
    " ",
    " ",
  );

  const record = createAnnotation({
    anchor: { blockId: "", quote: { exact, prefix, suffix } },
    body,
    target,
  });
  log.add(record);

  const mark = schema.marks.annotation.create({ id: record.id });
  view.dispatch(view.state.tr.addMark(from, to, mark));
  return record;
}

// Walk the document for annotation marks. Pre-order traversal yields document
// order by construction; we merge contiguous text-node runs of the same id and
// keep one entry per id at its first position. No separate position store.
export function scanAnnotations(doc: PMNode): PlacedAnnotation[] {
  const runs: PlacedAnnotation[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type.name === "annotation");
    if (!mark) return true;
    const id = mark.attrs.id as string;
    const from = pos;
    const to = pos + node.nodeSize;
    const text = node.text ?? "";
    const last = runs[runs.length - 1];
    if (last && last.id === id && last.to === from) {
      last.to = to;
      last.text += text;
    } else {
      runs.push({ id, from, to, text });
    }
    return true;
  });

  const seen = new Set<string>();
  return runs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
