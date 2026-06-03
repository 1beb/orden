import { describe, it, expect, vi } from "vitest";
import type { OrdenAnnotation } from "@orden/annotation-core";
import { renderSourcePanel } from "../src/sourcePanel";

const base: OrdenAnnotation = {
  id: "a1", created: "2026-06-02T00:00:00.000Z", creator: { kind: "human", id: "me" },
  target: { source: { kind: "file", vaultPath: "a.ts", contentHash: "sha256:z" },
            selector: { type: "text-quote", exact: "foo", prefix: "", suffix: "" } },
  body: { text: "a note" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
};

describe("renderSourcePanel", () => {
  it("renders a row per annotation with quote + note", () => {
    const list = document.createElement("ul");
    renderSourcePanel(list, [base, { ...base, id: "a2", body: { text: "second" } }], {});
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(list.textContent).toContain("foo");
    expect(list.textContent).toContain("a note");
  });

  it("fires onSelect/onDelete callbacks", () => {
    const list = document.createElement("ul");
    const onSelect = vi.fn(), onDelete = vi.fn();
    renderSourcePanel(list, [base], { onSelect, onDelete });
    list.querySelector("li")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith("a1");
    list.querySelector<HTMLButtonElement>("button.del")!.click();
    expect(onDelete).toHaveBeenCalledWith("a1");
  });

  it("shows an empty hint when there are no annotations", () => {
    const list = document.createElement("ul");
    renderSourcePanel(list, [], {});
    expect(list.textContent).toMatch(/no annotations/i);
  });
});
