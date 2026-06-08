import { describe, test, expect, vi } from "vitest";
import type { Learning } from "@orden/host-api";
import {
  deliverLearningComment,
  renderComment,
  type DeliveredState,
} from "../src/deliverLearningComment";

function learning(over: Partial<Learning> = {}): Learning {
  return {
    id: "L1",
    cardId: "C1",
    sessionId: "S1",
    projectId: "p1",
    type: "readme",
    title: "Document the watcher",
    recap: "",
    targetPath: "docs/WATCHER.md",
    op: "edit",
    proposedContent: "# Watcher\n",
    status: "pending",
    createdAt: 0,
    ...over,
  };
}

describe("deliverLearningComment", () => {
  test("delivers the rendered comment to the learning's session", async () => {
    const deliver = vi.fn(async (_sessionId: string, _text: string): Promise<DeliveredState> => "queued");
    const r = await deliverLearningComment(
      { getLearning: async () => learning(), deliver },
      "L1",
      "tighten the example",
    );
    expect(r).toEqual({ delivered: "queued" });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [sessionId, text] = deliver.mock.calls[0];
    expect(sessionId).toBe("S1");
    // Actionable for the agent: carries the title, the target, and the user's words.
    expect(text).toContain("Document the watcher");
    expect(text).toContain("docs/WATCHER.md");
    expect(text).toContain("tighten the example");
    expect(text).toContain("learning_propose");
  });

  test("maps the delivery state through (relaunched)", async () => {
    const deliver = vi.fn(async (): Promise<DeliveredState> => "relaunched");
    const r = await deliverLearningComment(
      { getLearning: async () => learning(), deliver },
      "L1",
      "x",
    );
    expect(r).toEqual({ delivered: "relaunched" });
  });

  test("returns not-linked and never delivers when the learning has no session", async () => {
    const deliver = vi.fn(async (): Promise<DeliveredState> => "queued");
    const r = await deliverLearningComment(
      { getLearning: async () => learning({ sessionId: undefined }), deliver },
      "L1",
      "x",
    );
    expect(r).toEqual({ delivered: "not-linked" });
    expect(deliver).not.toHaveBeenCalled();
  });

  test("throws when the learning is missing (mirrors applyLearning)", async () => {
    const deliver = vi.fn(async (): Promise<DeliveredState> => "queued");
    await expect(
      deliverLearningComment({ getLearning: async () => null, deliver }, "nope", "x"),
    ).rejects.toThrow(/learning not found: nope/);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("renderComment", () => {
  test("embeds the title, target path, and user text", () => {
    const text = renderComment(learning(), "be more concise");
    expect(text).toContain('"Document the watcher"');
    expect(text).toContain("docs/WATCHER.md");
    expect(text).toContain("be more concise");
  });
});
