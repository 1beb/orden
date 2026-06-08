import { describe, it, expect } from "vitest";
import { renderDoc, type RenderRunner } from "../src/docRender.js";

// A fake runner lets us drive renderDoc's branches without shelling out to a
// real quarto binary.
const fake = (out: { stdout: string; stderr: string; code: number }): RenderRunner =>
  async () => out;

describe("renderDoc", () => {
  it("resolves quarto's relative Output line against the source dir", async () => {
    const r = await renderDoc(
      "/repo/doc.qmd",
      fake({ stdout: "Output created: doc.html\n", stderr: "", code: 0 }),
    );
    expect(r).toEqual({ ok: true, outputPath: "/repo/doc.html" });
  });

  it("keeps an already-absolute Output path as-is", async () => {
    const r = await renderDoc(
      "/repo/doc.qmd",
      fake({ stdout: "Output created: /repo/sub/doc.html\n", stderr: "", code: 0 }),
    );
    expect(r).toEqual({ ok: true, outputPath: "/repo/sub/doc.html" });
  });

  it("falls back to an extension swap when no Output line is printed", async () => {
    const r = await renderDoc(
      "/repo/doc.qmd",
      fake({ stdout: "rendering...\n", stderr: "", code: 0 }),
    );
    expect(r).toEqual({ ok: true, outputPath: "/repo/doc.html" });
  });

  it("reports failure with errors drawn from stderr", async () => {
    const r = await renderDoc(
      "/repo/doc.qmd",
      fake({ stdout: "", stderr: "ERROR: bad chunk", code: 1 }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("bad chunk");
  });

  it("falls back to stdout for errors when stderr is empty", async () => {
    const r = await renderDoc(
      "/repo/doc.qmd",
      fake({ stdout: "compilation failed: undefined ref", stderr: "", code: 1 }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("undefined ref");
  });
});
