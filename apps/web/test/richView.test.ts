import { describe, expect, it } from "vitest";
import { repoFileUrl } from "../src/richView";

describe("repoFileUrl", () => {
  it("includes the projectId and percent-encodes each path segment", () => {
    expect(repoFileUrl("pa", "a/b c.png")).toBe("/repo-file/pa/a/b%20c.png");
  });

  it("encodes the projectId", () => {
    expect(repoFileUrl("proj x", "a.png")).toBe("/repo-file/proj%20x/a.png");
  });

  it("preserves slashes between segments but encodes within them", () => {
    expect(repoFileUrl("p", "dir/sub/img@2.png")).toBe("/repo-file/p/dir/sub/img%402.png");
  });

  it("encodes characters that would break the url", () => {
    expect(repoFileUrl("repo", "a?b/c#d.png")).toBe("/repo-file/repo/a%3Fb/c%23d.png");
  });
});
