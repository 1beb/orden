import { describe, expect, it } from "vitest";
import { repoFileUrl, renderHtmlView, renderImageView } from "../src/richView";

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

describe("renderImageView", () => {
  it("returns the img and overlay layer, with the img src set to the repo-file url", () => {
    const container = document.createElement("div");
    const { img, layer, wrap } = renderImageView(container, { title: "t", path: "docs/a.png" });
    expect(img).toBeInstanceOf(HTMLImageElement);
    expect(layer.classList.contains("region-layer")).toBe(true);
    expect(img.getAttribute("src")).toBe("/repo-file/docs/a.png");
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
