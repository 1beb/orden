import { describe, expect, it } from "vitest";
import { repoFileUrl } from "../src/richView";

describe("repoFileUrl", () => {
  it("builds a /repo-file/ url from a repo-relative path", () => {
    expect(repoFileUrl("docs/a.png")).toBe("/repo-file/docs/a.png");
  });

  it("encodes each segment but keeps the slashes", () => {
    expect(repoFileUrl("my notes/a b.png")).toBe("/repo-file/my%20notes/a%20b.png");
  });

  it("encodes characters that would break the url", () => {
    expect(repoFileUrl("a?b/c#d.png")).toBe("/repo-file/a%3Fb/c%23d.png");
  });
});
