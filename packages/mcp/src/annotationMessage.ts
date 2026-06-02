// Pure formatters that turn annotation records into the plain text a host types
// into an agent's TUI. Kept free of any vault/host import so they're trivially
// testable and reusable from the host's delivery layer.
//
// The annotation RECORD model and the web "send to agent" UI don't exist yet, so
// this defines the minimal shape the delivery layer needs. `quote` is the
// selector's exact text when the annotation targets a text range; it is absent
// for position/region selectors, in which case we reference the block instead.
// The quote ALWAYS comes from the selector — we never re-read the doc here.

export interface DeliverableAnnotation {
  id: string;
  planDoc: string;
  quote?: string;
  note: string;
  blockId?: string;
}

// The "what is this annotation pointing at" line. A quoted excerpt when we have
// one, else a block reference (with the block id when known).
function anchorLine(a: DeliverableAnnotation): string {
  if (a.quote !== undefined && a.quote !== "") return `> "${a.quote}"`;
  return a.blockId ? `(see annotation ${a.id} at block ${a.blockId})` : `(see annotation ${a.id})`;
}

export function renderSingle(a: DeliverableAnnotation): string {
  return [
    `[orden annotation on ${a.planDoc}]`,
    anchorLine(a),
    a.note,
    `(annotation ${a.id} — reply in-thread or resolve when addressed)`,
  ].join("\n");
}

export function renderBatch(planDoc: string, as: DeliverableAnnotation[]): string {
  const header = `[orden — ${as.length} annotations on ${planDoc}]`;
  const items = as.map((a, i) => {
    const n = `${i + 1}. `;
    // The note is indented to line up under the anchor text (past the "N. ").
    const pad = " ".repeat(n.length);
    return `${n}${anchorLine(a)}\n${pad}${a.note}`;
  });
  return [header, ...items].join("\n");
}
