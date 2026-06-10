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

  it("renders a markdown table", () => {
    const el = renderMarkdown(
      "| Col A | Col B |\n|-------|-------|\n| a1 | b1 |\n| a2 | b2 |",
    );
    const table = el.querySelector("table.chat-md-table");
    expect(table).not.toBeNull();
    const headerCells = table!.querySelectorAll("thead th");
    expect(headerCells).toHaveLength(2);
    expect(headerCells[0].textContent).toBe("Col A");
    expect(headerCells[1].textContent).toBe("Col B");
    const dataCells = table!.querySelectorAll("tbody td");
    expect(dataCells).toHaveLength(4);
    expect(dataCells[0].textContent).toBe("a1");
    expect(dataCells[3].textContent).toBe("b2");
  });

  it("renders a table with alignment", () => {
    const el = renderMarkdown(
      "| L | C | R |\n|:---|:---:|---:|\n| x | y | z |",
    );
    const ths = el.querySelectorAll("thead th");
    expect(ths[0].style.textAlign).toBe("left");
    expect(ths[1].style.textAlign).toBe("center");
    expect(ths[2].style.textAlign).toBe("right");
  });

  it("renders a table without leading/trailing pipes", () => {
    const el = renderMarkdown(
      "Col A | Col B\n-------|-------\na1 | b1",
    );
    const table = el.querySelector("table.chat-md-table");
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll("thead th")).toHaveLength(2);
    expect(table!.querySelectorAll("tbody td")).toHaveLength(2);
  });
});
