import { describe, test, expect, vi } from "vitest";
import {
  requestSessionComplete,
  renderCompleteRequest,
  type DeliveredState,
} from "../src/requestSessionComplete";

describe("requestSessionComplete", () => {
  test("delivers the rendered complete-request to the session", async () => {
    const deliver = vi.fn(async (_sessionId: string, _text: string): Promise<DeliveredState> => "queued");
    const r = await requestSessionComplete(
      { getSession: async () => ({ id: "S1" }), deliver },
      "S1",
    );
    expect(r).toEqual({ delivered: "queued" });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [sessionId, text] = deliver.mock.calls[0];
    expect(sessionId).toBe("S1");
    // Actionable for the agent: distill learnings first, then complete the card.
    expect(text).toContain("learning_propose");
    expect(text).toContain("card_complete");
  });

  test("maps the delivery state through (relaunched)", async () => {
    const deliver = vi.fn(async (): Promise<DeliveredState> => "relaunched");
    const r = await requestSessionComplete(
      { getSession: async () => ({ id: "S1" }), deliver },
      "S1",
    );
    expect(r).toEqual({ delivered: "relaunched" });
  });

  test("returns not-linked and never delivers when the session record is gone", async () => {
    const deliver = vi.fn(async (): Promise<DeliveredState> => "queued");
    const r = await requestSessionComplete({ getSession: async () => null, deliver }, "nope");
    expect(r).toEqual({ delivered: "not-linked" });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("renderCompleteRequest", () => {
  test("authorizes completion and orders learnings before card_complete", () => {
    const text = renderCompleteRequest();
    // The user's click IS the explicit say-so card_complete is gated on.
    expect(text.toLowerCase()).toContain("user");
    expect(text).toContain("learning_propose");
    expect(text).toContain("card_complete");
    // Learnings carry full file content, never a diff.
    expect(text.toLowerCase()).toContain("full");
    expect(text.indexOf("learning_propose")).toBeLessThan(text.indexOf("card_complete"));
  });
});
