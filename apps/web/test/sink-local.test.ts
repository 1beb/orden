import { beforeEach, describe, expect, it } from "vitest";
import {
  createAnnotation,
  sendFeedback,
  type Annotation,
} from "@orden/annotation-core";
import { BrowserHost } from "../src/host/browserHost";
import { VaultSink, hydrateOutbox, readOutbox } from "../src/sink-local";

function makeAnnotation(body: string): Annotation {
  return createAnnotation({ anchor: { blockId: "b1" }, body });
}

describe("VaultSink / readOutbox (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateOutbox(new BrowserHost());
  });

  it("readOutbox returns [] when nothing has been sent", () => {
    expect(readOutbox()).toEqual([]);
  });

  it("send appends one entry whose items match the batch", async () => {
    const batch = [makeAnnotation("one"), makeAnnotation("two")];
    await new VaultSink().send(batch);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].items).toEqual(batch);
    expect(Number.isNaN(Date.parse(outbox[0].at))).toBe(false);
  });

  it("two sends accumulate two entries", async () => {
    const sink = new VaultSink();
    await sink.send([makeAnnotation("first")]);
    await sink.send([makeAnnotation("second")]);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox[0].items[0].body).toBe("first");
    expect(outbox[1].items[0].body).toBe("second");
  });

  it("works end-to-end with sendFeedback: items marked sent and batch recorded", async () => {
    const sent = await sendFeedback(new VaultSink(), [makeAnnotation("hello")]);
    expect(sent.every((a) => a.status === "sent")).toBe(true);

    const outbox = readOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].items[0].status).toBe("sent");
    expect(outbox[0].items[0].body).toBe("hello");
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    await new VaultSink().send([makeAnnotation("kept")]);
    await hydrateOutbox(new BrowserHost());
    expect(readOutbox()).toHaveLength(1);
    expect(readOutbox()[0].items[0].body).toBe("kept");
  });
});
