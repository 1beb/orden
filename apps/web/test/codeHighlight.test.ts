import { describe, expect, it } from "vitest";
import { isCodeFile, languageForPath, splitHighlightedLines, viewerFor } from "../src/codeHighlight";

describe("isCodeFile", () => {
  it("treats markdown as NOT a code file (it opens in the prose editor)", () => {
    expect(isCodeFile("README.md")).toBe(false);
    expect(isCodeFile("notes.markdown")).toBe(false);
    expect(isCodeFile("doc.mdx")).toBe(false);
  });

  it("treats everything else — including html — as a code file", () => {
    expect(isCodeFile("src/main.ts")).toBe(true);
    expect(isCodeFile("page.html")).toBe(true);
    expect(isCodeFile("pkg.json")).toBe(true);
    expect(isCodeFile("LICENSE")).toBe(true);
  });
});

describe("viewerFor", () => {
  it("routes markdown to the prose editor regardless of the html-render flag", () => {
    expect(viewerFor("README.md", true)).toBe("prose");
    expect(viewerFor("notes.markdown", false)).toBe("prose");
    expect(viewerFor("doc.mdx", true)).toBe("prose");
  });

  it("routes images to the image viewer (binary has no code view)", () => {
    for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.svg", "f.webp"]) {
      expect(viewerFor(p, true)).toBe("image");
      expect(viewerFor(p, false)).toBe("image"); // flag never matters for images
    }
  });

  it("routes html to rendered when the flag is on, source when off", () => {
    expect(viewerFor("page.html", true)).toBe("html");
    expect(viewerFor("page.htm", true)).toBe("html");
    expect(viewerFor("page.html", false)).toBe("code");
    expect(viewerFor("page.htm", false)).toBe("code");
  });

  it("routes every other file to the code viewer", () => {
    expect(viewerFor("src/main.ts", true)).toBe("code");
    expect(viewerFor("pkg.json", false)).toBe("code");
    expect(viewerFor("LICENSE", true)).toBe("code");
  });
});

describe("languageForPath", () => {
  it("maps common code extensions to hljs language names", () => {
    expect(languageForPath("src/main.ts")).toBe("typescript");
    expect(languageForPath("a/b.tsx")).toBe("typescript");
    expect(languageForPath("x.js")).toBe("javascript");
    expect(languageForPath("pkg.json")).toBe("json");
    expect(languageForPath("styles.css")).toBe("css");
    expect(languageForPath("page.html")).toBe("xml");
    expect(languageForPath("conf.yaml")).toBe("yaml");
  });

  it("returns undefined for unknown/extensionless files (hljs auto-detects)", () => {
    expect(languageForPath("LICENSE")).toBeUndefined();
    expect(languageForPath("notes.xyz")).toBeUndefined();
  });

  it("is case-insensitive on the extension", () => {
    expect(languageForPath("App.TS")).toBe("typescript");
  });
});

describe("splitHighlightedLines", () => {
  it("splits plain (span-free) text on newlines", () => {
    expect(splitHighlightedLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("keeps a span that does not cross a newline intact", () => {
    expect(splitHighlightedLines('<span class="hljs-kw">const</span> x')).toEqual([
      '<span class="hljs-kw">const</span> x',
    ]);
  });

  it("re-opens a span that crosses a newline on the next line", () => {
    // A block comment highlighted as one span that spans two source lines.
    const html = '<span class="hljs-comment">/* line one\nline two */</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="hljs-comment">/* line one</span>',
      '<span class="hljs-comment">line two */</span>',
    ]);
  });

  it("handles nested spans crossing a newline", () => {
    const html = '<span class="a">x<span class="b">y\nz</span>w</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a">x<span class="b">y</span></span>',
      '<span class="a"><span class="b">z</span>w</span>',
    ]);
  });

  it("preserves a blank line between content", () => {
    expect(splitHighlightedLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("preserves HTML entities verbatim", () => {
    expect(splitHighlightedLines("a &lt;b&gt; &amp; c")).toEqual(["a &lt;b&gt; &amp; c"]);
  });
});
