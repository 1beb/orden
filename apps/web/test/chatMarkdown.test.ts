import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/chatMarkdown";

describe("renderMarkdown", () => {
  it("renders headings, bold, inline code, and links", () => {
    const el = renderMarkdown("# Title\n\nsome **bold** and `code` and [link](https://x.com)");
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(el.querySelector("code.chat-md-inline-code")?.textContent).toBe("code");
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://x.com");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders a fenced code block verbatim with its language", () => {
    const el = renderMarkdown("```ts\nconst x = 1;\n```");
    const code = el.querySelector("pre.chat-md-code code");
    expect(code?.textContent).toBe("const x = 1;");
    expect(code?.getAttribute("data-lang")).toBe("ts");
  });

  it("renders bullet and numbered lists", () => {
    const ul = renderMarkdown("- one\n- two").querySelector("ul.chat-md-list");
    expect(ul?.querySelectorAll("li")).toHaveLength(2);
    const ol = renderMarkdown("1. first\n2. second").querySelector("ol.chat-md-list");
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
  });

  it("does not execute or emit a javascript: link (no XSS)", () => {
    const a = renderMarkdown("[x](javascript:alert(1))").querySelector("a");
    expect(a?.getAttribute("href")).toBe("#");
    // text is set via textContent, so no markup is injected
    expect(renderMarkdown("<img src=x onerror=alert(1)>").textContent).toContain("<img");
  });
});
