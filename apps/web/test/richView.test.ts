import { describe, expect, it } from "vitest";
import { repoFileUrl, renderHtmlView, renderImageView } from "../src/richView";

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

describe("renderImageView", () => {
  it("returns the img and overlay layer, with the img src set to the repo-file url", () => {
    const container = document.createElement("div");
    const { img, layer, wrap } = renderImageView(container, {
      title: "t",
      path: "docs/a.png",
      projectId: "pa",
    });
    expect(img).toBeInstanceOf(HTMLImageElement);
    expect(layer.classList.contains("region-layer")).toBe(true);
    expect(img.getAttribute("src")).toBe("/repo-file/pa/docs/a.png");
    expect(wrap.contains(img)).toBe(true);
    expect(wrap.contains(layer)).toBe(true);
    expect(container.contains(wrap)).toBe(true);
  });
});

describe("renderHtmlView sandbox", () => {
  it("owned HTML renders same-origin", () => {
    const container = document.createElement("div");
    const frame = renderHtmlView(container, { title: "t", content: "<p>hi</p>", owned: true });
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
  });

  it("external (default) HTML stays null-origin", () => {
    const container = document.createElement("div");
    const frame = renderHtmlView(container, { title: "t", content: "<p>hi</p>" });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });
});
