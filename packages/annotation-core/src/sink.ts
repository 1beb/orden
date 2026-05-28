import type { Annotation } from "./types";

export interface SinkAdapter {
  send(batch: Annotation[]): Promise<void>;
}

export class MemorySink implements SinkAdapter {
  batches: Annotation[][] = [];
  async send(batch: Annotation[]): Promise<void> {
    this.batches.push(batch);
  }
}

export async function sendFeedback(
  sink: SinkAdapter,
  items: Annotation[],
): Promise<Annotation[]> {
  const sent = items.map((a) => ({ ...a, status: "sent" as const }));
  await sink.send(sent);
  return sent;
}
