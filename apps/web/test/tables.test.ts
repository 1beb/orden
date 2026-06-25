import { describe, it, expect } from "vitest";
import { markdownParser, markdownSerializer, schema } from "../src/schema";
import { DOMSerializer, type Node as PMNode } from "prosemirror-model";

const GFM = [
  "| Format | Read (s) | Write (s) |",
  "| --- | ---: | :---: |",
  "| arrow | 0.12 | 0.20 |",
  "| dt | 0.08 | 0.15 |",
].join("\n");

function find(doc: PMNode, name: string): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((n) => {
    if (n.type.name === name) out.push(n);
  });
  return out;
}

describe("GFM tables in pages", () => {
  it("registers table node types in the schema", () => {
    expect(schema.nodes.table).toBeDefined();
    expect(schema.nodes.table_row).toBeDefined();
    expect(schema.nodes.table_cell).toBeDefined();
    expect(schema.nodes.table_header).toBeDefined();
  });

  it("parses a pipe table into a table node with the right shape", () => {
    const doc = markdownParser.parse(GFM);
    const tables = find(doc, "table");
    expect(tables).toHaveLength(1);
    const rows = find(doc, "table_row");
    expect(rows).toHaveLength(3); // 1 header + 2 body
    expect(find(doc, "table_header")).toHaveLength(3); // header cells
    expect(find(doc, "table_cell")).toHaveLength(6); // 2 body rows x 3
  });

  it("captures per-column alignment on cells", () => {
    const doc = markdownParser.parse(GFM);
    const headers = find(doc, "table_header");
    expect(headers[0].attrs.align).toBe(null); // left/default
    expect(headers[1].attrs.align).toBe("right");
    expect(headers[2].attrs.align).toBe("center");
  });

  it("round-trips a table back to GFM, re-parsing to the same shape", () => {
    const doc = markdownParser.parse(GFM);
    const out = markdownSerializer.serialize(doc);
    const reparsed = markdownParser.parse(out);
    expect(find(reparsed, "table")).toHaveLength(1);
    expect(find(reparsed, "table_row")).toHaveLength(3);
    const headers = find(reparsed, "table_header");
    expect(headers[1].attrs.align).toBe("right");
    expect(headers[2].attrs.align).toBe("center");
    expect(out).toContain("| Format | Read (s) | Write (s) |");
  });
});

describe("repro: Comparison of CSV IO page", () => {
  const PAGE = [
    "| shape | size (MB) | fread (s) | arrow (s) | arrow speedup |",
    "|-------|----------:|----------:|----------:|--------------:|",
    "| long  | 5    | 0.006 | 0.006 | 1.18x |",
    "| wide  | 5    | 0.008 | 0.005 | 1.50x |",
    "| long  | 50   | 0.035 | 0.019 | 1.84x |",
  ].join("\n");

  it("parses the right-aligned numeric table and round-trips it", () => {
    const doc = markdownParser.parse(PAGE);
    expect(find(doc, "table")).toHaveLength(1);
    expect(find(doc, "table_row")).toHaveLength(4); // header + 3 body
    const headers = find(doc, "table_header");
    // first column left (null), the four numeric columns right-aligned
    expect(headers.map((h) => h.attrs.align)).toEqual([
      null,
      "right",
      "right",
      "right",
      "right",
    ]);
    const out = markdownSerializer.serialize(doc);
    const reparsed = markdownParser.parse(out);
    expect(find(reparsed, "table")).toHaveLength(1);
    expect(find(reparsed, "table_header").map((h) => h.attrs.align)).toEqual(
      headers.map((h) => h.attrs.align),
    );
  });
});

describe("repro: table directly after a heading (INNOV-2888 §2)", () => {
  // A table that immediately follows another block (here a heading) used to
  // serialize glued onto it — "## Title| col | col |" — because renderCell's
  // buffer swap let the pending block-close get flushed into the discarded
  // cell buffer. The result re-parses as a heading + orphaned delimiter, so
  // the table renders as raw pipe text. The header-less round-trip tests above
  // never caught it because nothing precedes their table.
  const DOC = [
    "## 2. Prior work",
    "",
    "| Branch | Worktree | Holds |",
    "|---|---|---|",
    "| `a/b` | `s1` | `x.R`, `y.R` |",
    "| `c/d` | `s2` | `z.qmd` |",
    "",
    "Some text after.",
  ].join("\n");

  it("keeps the heading and the table header on separate lines", () => {
    const out = markdownSerializer.serialize(markdownParser.parse(DOC));
    expect(out).not.toMatch(/Prior work\|/); // not glued
    expect(out).toMatch(/^## 2\. Prior work$/m); // heading on its own line
    expect(out).toMatch(/\| Branch \| Worktree \| Holds \|\n\| --- \| --- \| --- \|/);
  });

  it("re-parses the re-serialized output to a real table", () => {
    const out = markdownSerializer.serialize(markdownParser.parse(DOC));
    const reparsed = markdownParser.parse(out);
    expect(find(reparsed, "table")).toHaveLength(1);
    expect(find(reparsed, "table_row")).toHaveLength(3); // header + 2 body
  });
});

describe("table DOM rendering", () => {
  it("renders a <table> with per-column text-align styles", () => {
    const doc = markdownParser.parse(GFM);
    const serializer = DOMSerializer.fromSchema(schema);
    const frag = serializer.serializeFragment(doc.content);
    const host = document.createElement("div");
    host.appendChild(frag);
    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    expect(host.querySelectorAll("tr")).toHaveLength(3);
    // header cells: col2 right, col3 center carry inline alignment
    const ths = host.querySelectorAll("th");
    expect(ths[1].getAttribute("style")).toContain("text-align: right");
    expect(ths[2].getAttribute("style")).toContain("text-align: center");
  });
});
