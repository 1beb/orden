import { describe, expect, it } from "vitest";
import { fuzzyScore, fuzzyRank } from "../src/fuzzy";

describe("fuzzyScore", () => {
  it("returns null when chars are not a subsequence", () => {
    expect(fuzzyScore("xyz", "hello")).toBeNull();
  });
  it("matches a subsequence case-insensitively", () => {
    expect(fuzzyScore("hlo", "Hello")).not.toBeNull();
  });
  it("scores contiguous + prefix matches higher than scattered", () => {
    const prefix = fuzzyScore("hel", "hello world")!;
    const scattered = fuzzyScore("hel", "h e l p f u l")!;
    expect(prefix).toBeGreaterThan(scattered);
  });
  it("empty query scores 0 (matches everything)", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("fuzzyRank", () => {
  it("drops non-matches and sorts by score desc", () => {
    const items = [{ t: "apple" }, { t: "kiwi" }, { t: "maple" }];
    const ranked = fuzzyRank("ap", items, (i) => i.t);
    expect(ranked.map((r) => r.item.t)).toEqual(["apple", "maple"]);
  });
});
