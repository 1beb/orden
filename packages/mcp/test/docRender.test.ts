import { describe, it, expect } from "vitest";
import type { Host, RenderResult } from "@orden/host-api";
import { docRender } from "../src/tools";

function resultText(res: { content: Array<{ type: string; text: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// A host with an injectable render() — we don't need the rest of the Host spine
// for these tool-level tests, so cast a minimal object.
function hostWithRender(impl?: (projectId: string, path: string) => Promise<RenderResult>): Host {
  return (impl ? { render: impl } : {}) as unknown as Host;
}

describe("docRender tool", () => {
  it("reports the project-relative output path on success", async () => {
    const host = hostWithRender(async () => ({ ok: true, outputPath: "docs/report.html" }));
    const res = await docRender(host, "repo", "docs/report.qmd");
    const t = resultText(res);
    expect(t).toContain("docs/report.html");
    expect(t).toContain("docs/report.qmd");
  });

  it("surfaces FAILED + the error text on failure", async () => {
    const host = hostWithRender(async () => ({ ok: false, errors: "boom" }));
    const res = await docRender(host, "repo", "docs/report.qmd");
    const t = resultText(res);
    expect(t).toContain("FAILED");
    expect(t).toContain("boom");
  });

  it("reports unavailable when the host cannot render", async () => {
    const host = hostWithRender(undefined);
    const res = await docRender(host, "repo", "docs/report.qmd");
    expect(resultText(res)).toContain("unavailable");
  });
});
