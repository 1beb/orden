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

  setStatus(id: string, status: Annotation["status"]): void {
    const rec = this.records.get(id);
    if (rec) this.records.set(id, { ...rec, status });
  }

  all(): Annotation[] {
    return [...this.records.values()];
  }

  clear(): void {
    this.records.clear();
  }
}
