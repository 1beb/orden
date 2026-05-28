import { describe, it, expect } from "vitest";
import { createAnnotation } from "../src/annotation";
import { MemorySink, sendFeedback } from "../src/sink";

describe("sendFeedback", () => {
  it("delivers a batch to the sink and marks items sent", async () => {
    const sink = new MemorySink();
    const items = [
      createAnnotation({ anchor: { blockId: "b1" }, body: "one" }),
      createAnnotation({ anchor: { blockId: "b2" }, body: "two", target: "human" }),
    ];

    const sent = await sendFeedback(sink, items);

    expect(sink.batches.length).toBe(1);
    expect(sink.batches[0].length).toBe(2);
    expect(sent.every((a) => a.status === "sent")).toBe(true);
    expect(sink.batches[0][1].target).toBe("human");
  });
});
