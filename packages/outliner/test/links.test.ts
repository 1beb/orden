import { describe, it, expect } from "vitest";
import { extractLinks } from "../src/links";
import { buildBacklinkIndex } from "../src/backlinks";
import { createRoot, createBlock } from "../src/blockTree";
import { createJournalPage, journalKey } from "../src/page";

describe("extractLinks", () => {
  it("pulls a single [[target]]", () => {
    expect(extractLinks("see [[Project X]]")).toEqual(["Project X"]);
  });

  it("pulls multiple targets in order", () => {
    expect(extractLinks("[[a]] then [[b]] and [[c]]")).toEqual(["a", "b", "c"]);
  });

  it("dedupes repeats within one block", () => {
    expect(extractLinks("[[a]] [[a]] [[b]]")).toEqual(["a", "b"]);
  });

  it("trims whitespace inside brackets", () => {
    expect(extractLinks("[[  spaced name  ]]")).toEqual(["spaced name"]);
  });

  it("returns empty for no links", () => {
    expect(extractLinks("plain text")).toEqual([]);
  });

  it("ignores empty brackets", () => {
    expect(extractLinks("[[]] and [[ ]]")).toEqual([]);
  });
});

describe("buildBacklinkIndex", () => {
  it("maps a page name to the blocks that reference it", () => {
    const root = createRoot([
      createBlock("b1", "talking about [[Foo]]"),
      createBlock("b2", "nothing here"),
      createBlock("b3", "more on [[Foo]] and [[Bar]]"),
    ]);
    const page = { name: "2026-05-28", root };
    const idx = buildBacklinkIndex([page]);
    expect(idx["Foo"].map((r) => r.blockId)).toEqual(["b1", "b3"]);
    expect(idx["Bar"].map((r) => r.blockId)).toEqual(["b3"]);
    expect(idx["Bar"][0].pageName).toBe("2026-05-28");
  });

  it("indexes nested blocks", () => {
    const root = createRoot([createBlock("p", "parent")]);
    root.children[0].children.push(createBlock("c", "child cites [[Topic]]"));
    const idx = buildBacklinkIndex([{ name: "page", root }]);
    expect(idx["Topic"].map((r) => r.blockId)).toEqual(["c"]);
  });

  it("spans multiple pages", () => {
    const p1 = { name: "p1", root: createRoot([createBlock("x", "[[Shared]]")]) };
    const p2 = { name: "p2", root: createRoot([createBlock("y", "[[Shared]]")]) };
    const idx = buildBacklinkIndex([p1, p2]);
    expect(idx["Shared"].map((r) => r.pageName)).toEqual(["p1", "p2"]);
  });

  it("is empty when there are no links", () => {
    const idx = buildBacklinkIndex([
      { name: "p", root: createRoot([createBlock("x", "no links")]) },
    ]);
    expect(Object.keys(idx)).toEqual([]);
  });
});

describe("journal pages", () => {
  it("journalKey formats a Date as ISO yyyy-mm-dd in the given zone", () => {
    expect(journalKey(new Date("2026-05-28T12:00:00Z"), "UTC")).toBe("2026-05-28");
  });

  it("files an entry on the local calendar day, not the UTC day", () => {
    // 01:00 UTC on May 31 is still 21:00 on May 30 in Toronto (UTC-4 in summer).
    // The old UTC keying rolled such evening entries onto the next day's page;
    // a zone-aware key keeps them on the local day.
    const evening = new Date("2026-05-31T01:00:00Z");
    expect(journalKey(evening, "America/Toronto")).toBe("2026-05-30");
    expect(journalKey(evening, "UTC")).toBe("2026-05-31");
  });

  it("createJournalPage keys a page by its (local) date with an empty root", () => {
    const d = new Date("2026-01-09T12:00:00Z");
    const page = createJournalPage(d);
    expect(page.name).toBe(journalKey(d)); // default zone = runtime local
    expect(page.root.children).toEqual([]);
  });
});
