import {
  createOrdenAnnotation,
  type OrdenAnnotation,
  type OrdenAudience,
  type Source,
} from "@orden/annotation-core";
import { selectorsForRange } from "./textSelector";

// Compose a text selection + source + note into an OrdenAnnotation. Returns null
// when the selection yields no selectors (empty/collapsed range), so callers can
// drop the gesture without creating an empty annotation.
export function buildTextAnnotation(input: {
  source: Source;
  range: Range;
  root: Element;
  note: string;
  creator: { kind: "human" | "agent"; id: string };
  audience?: OrdenAudience;
}): OrdenAnnotation | null {
  const selector = selectorsForRange(input.range, input.root);
  if (selector.length === 0) return null;
  return createOrdenAnnotation({
    source: input.source,
    selector,
    body: { text: input.note },
    creator: input.creator,
    audience: input.audience ?? "agent",
  });
}
