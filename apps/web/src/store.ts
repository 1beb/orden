import type { Annotation } from "@orden/annotation-core";

// The durable log: annotation records keyed by id. In the slice this is in-memory;
// Phase 2 swaps in a localStorage-backed implementation behind the same shape.
// The document/marks are the source of truth for *position*; this log is the
// source of truth for *content* (body, target, status, quote).
export class AnnotationLog {
  private records = new Map<string, Annotation>();

  add(record: Annotation): void {
    this.records.set(record.id, record);
  }

  get(id: string): Annotation | undefined {
    return this.records.get(id);
  }

  all(): Annotation[] {
    return [...this.records.values()];
  }
}
