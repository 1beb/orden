import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import { resolutionReport, MERGE_RESOLUTION_NS } from "../src/tools";

const out = (r: { content: { text: string }[] }) => r.content[0].text;

describe("resolutionReport", () => {
  it("writes the verdict to the merge-resolution ns keyed by the resolver session id", async () => {
    const v = fakeVault({});
    const r = await resolutionReport(v, "sess_resolver", "intent-conflict", "A and B both own X");
    expect(out(r)).toContain("intent-conflict");
    expect(await v.get(MERGE_RESOLUTION_NS, "sess_resolver")).toEqual({
      kind: "intent-conflict",
      question: "A and B both own X",
    });
  });

  it("omits an empty question (resolved needs none)", async () => {
    const v = fakeVault({});
    await resolutionReport(v, "sess_resolver", "resolved");
    expect(await v.get(MERGE_RESOLUTION_NS, "sess_resolver")).toEqual({ kind: "resolved" });
  });

  it("refuses and writes nothing when the connection isn't bound to a session", async () => {
    const v = fakeVault({});
    const r = await resolutionReport(v, undefined, "resolved");
    expect(out(r)).toMatch(/not bound|isn't bound|no session/i);
    expect(await v.list(MERGE_RESOLUTION_NS)).toEqual([]);
  });
});
