import { describe, it, expect, vi } from "vitest";
import { buildNoteComposer } from "../src/noteComposer";

describe("buildNoteComposer", () => {
  it("fires onSave with the trimmed note on Save click", () => {
    const onSave = vi.fn();
    const c = buildNoteComposer({ onSave, onCancel: () => {} });
    c.textarea.value = "  hello  ";
    c.el.querySelector<HTMLButtonElement>("button.primary")!.click();
    expect(onSave).toHaveBeenCalledWith("hello");
  });

  it("saves on Cmd/Ctrl+Enter and cancels on Escape", () => {
    const onSave = vi.fn(), onCancel = vi.fn();
    const c = buildNoteComposer({ onSave, onCancel });
    c.textarea.value = "note";
    c.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    expect(onSave).toHaveBeenCalledWith("note");
    c.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("fires onCancel on Cancel click", () => {
    const onCancel = vi.fn();
    const c = buildNoteComposer({ onSave: () => {}, onCancel });
    c.el.querySelector<HTMLButtonElement>("button.ghost")!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("applies an extra class and placeholder", () => {
    const c = buildNoteComposer({ placeholder: "Note…", extraClass: "region-composer", onSave: () => {}, onCancel: () => {} });
    expect(c.el.classList.contains("annotator-composer")).toBe(true);
    expect(c.el.classList.contains("region-composer")).toBe(true);
    expect(c.textarea.placeholder).toBe("Note…");
  });
});
