import { afterEach, describe, expect, it } from "vitest";
import { openDialog, confirmDialog } from "../src/modal";

afterEach(() => {
  document.body.replaceChildren();
});

const click = (sel: string) =>
  (document.querySelector(sel) as HTMLElement | null)?.click();

describe("openDialog", () => {
  it("resolves with the chosen action id", async () => {
    const p = openDialog({
      title: "Pick",
      actions: [
        { id: "reassign", label: "Move" },
        { id: "cascade", label: "Delete", danger: true },
      ],
    });
    click(".dialog__btn--danger");
    expect(await p).toBe("cascade");
    expect(document.querySelector(".dialog-overlay")).toBeNull(); // closed
  });

  it("resolves null when cancelled", async () => {
    const p = openDialog({ title: "X", actions: [{ id: "ok", label: "OK" }] });
    click(".dialog__btn:not(.dialog__btn--primary):not(.dialog__btn--danger)"); // Cancel
    expect(await p).toBeNull();
  });

  it("resolves null on Escape", async () => {
    const p = openDialog({ title: "X", actions: [{ id: "ok", label: "OK" }] });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await p).toBeNull();
  });

  it("omits the cancel button when cancelLabel is null", async () => {
    const p = openDialog({ title: "X", actions: [{ id: "ok", label: "OK" }], cancelLabel: null });
    expect(document.querySelectorAll(".dialog__btn").length).toBe(1);
    click(".dialog__btn--primary");
    expect(await p).toBe("ok");
  });
});

describe("confirmDialog", () => {
  it("returns true on confirm, false on cancel", async () => {
    const yes = confirmDialog({ title: "Sure?" });
    click(".dialog__btn--danger");
    expect(await yes).toBe(true);

    const no = confirmDialog({ title: "Sure?" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await no).toBe(false);
  });
});
