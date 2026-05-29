import { beforeEach, describe, expect, it } from "vitest";
import {
  createAnnotation,
  sendFeedback,
  type Annotation,
} from "@orden/annotation-core";
import { LocalStorageSink, readOutbox } from "../src/sink-local";

const OUTBOX_KEY = "orden:feedback-outbox";

function makeAnnotation(body: string): Annotation {
  return createAnnotation({
    anchor: { blockId: "b1" },
    body,
  });
}

describe("LocalStorageSink / readOutbox", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("readOutbox returns [] when storage is empty", () => {
    expect(readOutbox()).toEqual([]);
  });

  it("send appends one entry whose items match the batch", async () => {
    const sink = new LocalStorageSink();
    const batch = [makeAnnotation("one"), makeAnnotation("two")];

    await sink.send(batch);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].items).toEqual(batch);
    expect(typeof outbox[0].at).toBe("string");
    expect(Number.isNaN(Date.parse(outbox[0].at))).toBe(false);
  });

  it("two sends accumulate two entries", async () => {
    const sink = new LocalStorageSink();

    await sink.send([makeAnnotation("first")]);
    await sink.send([makeAnnotation("second")]);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox[0].items[0].body).toBe("first");
    expect(outbox[1].items[0].body).toBe("second");
  });

  it("works end-to-end with sendFeedback: items marked sent and batch recorded", async () => {
    const sink = new LocalStorageSink();
    const items = [makeAnnotation("hello")];

    const sent = await sendFeedback(sink, items);

    expect(sent.every((a) => a.status === "sent")).toBe(true);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].items).toHaveLength(1);
    expect(outbox[0].items[0].status).toBe("sent");
    expect(outbox[0].items[0].body).toBe("hello");
  });

  it("readOutbox returns [] on malformed storage without throwing", () => {
    localStorage.setItem(OUTBOX_KEY, "{not valid json");
    expect(() => readOutbox()).not.toThrow();
    expect(readOutbox()).toEqual([]);
  });
});
