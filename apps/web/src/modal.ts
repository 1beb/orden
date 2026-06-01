// A small promise-based dialog used in place of the browser's native
// confirm()/alert(), so destructive actions get a styled modal that matches the
// app (and can offer more than two choices). Reuses the .preview-overlay /
// .preview-modal base from the card/preview modals.
//
// openDialog() resolves with the chosen action's `id`, or null if the user
// cancels (Cancel button, Escape, or clicking the backdrop). Multiple actions
// let one dialog ask "reassign vs cascade"; chain two calls for a double-confirm.

export interface DialogAction {
  id: string;
  label: string;
  // Renders the button in the destructive (red) style.
  danger?: boolean;
}

export interface DialogOptions {
  title: string;
  // Body text. Plain string; rendered as one paragraph (no HTML injection).
  message?: string;
  actions: DialogAction[];
  // Defaults to "Cancel"; pass null to omit the cancel button entirely.
  cancelLabel?: string | null;
}

export function openDialog(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay dialog-overlay";

    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") finish(null);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKey);

    const modal = document.createElement("div");
    modal.className = "preview-modal dialog";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const header = document.createElement("header");
    header.textContent = opts.title;
    modal.append(header);

    if (opts.message) {
      const body = document.createElement("p");
      body.className = "dialog__message";
      body.textContent = opts.message;
      modal.append(body);
    }

    const footer = document.createElement("div");
    footer.className = "dialog__actions";

    if (opts.cancelLabel !== null) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog__btn";
      cancel.textContent = opts.cancelLabel ?? "Cancel";
      cancel.addEventListener("click", () => finish(null));
      footer.append(cancel);
    }

    for (const action of opts.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = action.danger ? "dialog__btn dialog__btn--danger" : "dialog__btn dialog__btn--primary";
      btn.textContent = action.label;
      btn.addEventListener("click", () => finish(action.id));
      footer.append(btn);
    }

    modal.append(footer);
    overlay.append(modal);
    document.body.append(overlay);

    // Focus the last action (the affirmative one) so Enter confirms; Escape still cancels.
    (footer.querySelector(".dialog__btn:last-child") as HTMLElement | null)?.focus();
  });
}

// Convenience for the common single-confirm case (replaces window.confirm).
export function confirmDialog(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return openDialog({
    title: opts.title,
    message: opts.message,
    actions: [{ id: "confirm", label: opts.confirmLabel ?? "Confirm", danger: opts.danger ?? true }],
  }).then((r) => r === "confirm");
}
