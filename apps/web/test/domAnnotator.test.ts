import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountDomAnnotator } from "../src/domAnnotator";

function selectContents(el: Element): void {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("mountDomAnnotator (smoke)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows the pill on a non-empty selection, then composer -> Save wires onCreate", () => {
    const root = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "hello world";
    root.append(p);
    document.body.append(root);

    const onCreate = vi.fn();
    const inst = mountDomAnnotator({
      root,
      getSelection: () => window.getSelection(),
      onCreate,
    });

    selectContents(p);
    root.dispatchEvent(new Event("mouseup", { bubbles: true }));

    const pill = document.body.querySelector(".annotator");
    expect(pill).not.toBeNull();
    const btn = pill!.querySelector<HTMLButtonElement>(".annotator-pill");
    expect(btn).not.toBeNull();

    btn!.dispatchEvent(new Event("click", { bubbles: true }));
    const ta = document.body.querySelector<HTMLTextAreaElement>(".annotator-note");
    expect(ta).not.toBeNull();

    ta!.value = "  my note  ";
    const save = document.body.querySelector<HTMLButtonElement>(".annotator-actions .primary");
    expect(save).not.toBeNull();
    save!.dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const [range, note] = onCreate.mock.calls[0];
    expect(note).toBe("my note");
    expect(range.toString()).toBe("hello world");

    // Affordance dismisses after Save.
    expect(document.body.querySelector(".annotator")!.children.length).toBe(0);
    inst.destroy();
    expect(document.body.querySelector(".annotator")).toBeNull();
  });

  it("does not show the pill for a collapsed / empty selection", () => {
    const root = document.createElement("div");
    root.textContent = "text";
    document.body.append(root);

    const inst = mountDomAnnotator({
      root,
      getSelection: () => window.getSelection(),
      onCreate: vi.fn(),
    });

    window.getSelection()!.removeAllRanges();
    root.dispatchEvent(new Event("mouseup", { bubbles: true }));

    const pill = document.body.querySelector(".annotator");
    // Element exists (hidden host) but carries no pill button.
    expect(pill!.querySelector(".annotator-pill")).toBeNull();
    inst.destroy();
  });

  it("shifts the pill by a provided rectOffset", () => {
    const root = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "hello world";
    root.append(p);
    document.body.append(root);

    const inst = mountDomAnnotator({
      root,
      getSelection: () => window.getSelection(),
      onCreate: vi.fn(),
      rectOffset: () => ({ x: 100, y: 50 }),
    });

    selectContents(p);
    root.dispatchEvent(new Event("mouseup", { bubbles: true }));

    // happy-dom getBoundingClientRect is all-zeros, so the pill position is purely
    // the offset: left=0+100, top=0+50.
    const host = document.body.querySelector<HTMLDivElement>(".annotator")!;
    expect(host.style.left).toBe("100px");
    expect(host.style.top).toBe("50px");
    inst.destroy();
  });

  it("Cancel dismisses without calling onCreate", () => {
    const root = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "abc";
    root.append(p);
    document.body.append(root);

    const onCreate = vi.fn();
    const inst = mountDomAnnotator({
      root,
      getSelection: () => window.getSelection(),
      onCreate,
    });

    selectContents(p);
    root.dispatchEvent(new Event("mouseup", { bubbles: true }));
    document.body
      .querySelector<HTMLButtonElement>(".annotator-pill")!
      .dispatchEvent(new Event("click", { bubbles: true }));
    document.body
      .querySelector<HTMLButtonElement>(".annotator-actions .ghost")!
      .dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(document.body.querySelector(".annotator")!.children.length).toBe(0);
    inst.destroy();
  });
});
