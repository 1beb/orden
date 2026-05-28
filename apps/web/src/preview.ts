// A modal that shows the feedback payload text and copies it to the clipboard,
// so the reviewer can see exactly what will be passed along.
export function openPreview(title: string, payload: string): void {
  const overlay = document.createElement("div");
  overlay.className = "preview-overlay";

  const modal = document.createElement("div");
  modal.className = "preview-modal";

  const head = document.createElement("header");
  head.textContent = title;

  const text = document.createElement("textarea");
  text.className = "preview-text";
  text.readOnly = true;
  text.value = payload;

  const actions = document.createElement("div");
  actions.className = "preview-actions";
  const copy = document.createElement("button");
  copy.className = "primary";
  copy.textContent = "Copy to clipboard";
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Close";

  const dismiss = () => overlay.remove();
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      text.select();
      document.execCommand("copy");
    }
    copy.textContent = "Copied ✓";
    window.setTimeout(() => (copy.textContent = "Copy to clipboard"), 1200);
  });
  close.addEventListener("click", dismiss);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });

  actions.append(copy, close);
  modal.append(head, text, actions);
  overlay.append(modal);
  document.body.append(overlay);
  copy.focus();
}
