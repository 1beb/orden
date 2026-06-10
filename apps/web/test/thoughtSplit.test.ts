import { describe, expect, it } from "vitest";
import { splitThought } from "../src/thoughtSplit";

describe("splitThought", () => {
  it("splits on the first sentence terminator, stripping it from the title", () => {
    expect(splitThought("Fix the watcher test. It fails when inotify saturates.")).toEqual({
      title: "Fix the watcher test",
      description: "It fails when inotify saturates.",
    });
  });

  it("splits on ! and ?", () => {
    expect(splitThought("Ship it! Build the bundle first.")).toEqual({
      title: "Ship it",
      description: "Build the bundle first.",
    });
    expect(splitThought("Why is boot slow? Profile hydrate calls.")).toEqual({
      title: "Why is boot slow",
      description: "Profile hydrate calls.",
    });
  });

  it("returns null without a completed sentence followed by more text", () => {
    expect(splitThought("Just a title")).toBeNull();
    expect(splitThought("Trailing period.")).toBeNull();
    expect(splitThought("Trailing period. ")).toBeNull();
    expect(splitThought("")).toBeNull();
  });

  it("does not split on a period without following whitespace (v2.0 stays whole)", () => {
    expect(splitThought("Fix the v2.0 bug")).toBeNull();
  });

  it("splits at the FIRST boundary when several sentences follow", () => {
    expect(splitThought("Do X. Then Y. Then Z.")).toEqual({
      title: "Do X",
      description: "Then Y. Then Z.",
    });
  });

  it("treats a newline as a boundary even without punctuation", () => {
    expect(splitThought("Fix the watcher test\nIt fails twice a day")).toEqual({
      title: "Fix the watcher test",
      description: "It fails twice a day",
    });
  });
});
