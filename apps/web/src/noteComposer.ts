// A small inline note composer: a textarea + Save/Cancel, with Cmd/Ctrl+Enter to
// save and Escape to cancel. Shared by the text-selection annotator (domAnnotator)
// and the image-region annotator so the markup, classes, and key handling live in
// one place. Positioning and mounting are the caller's job — this only builds the
// box and wires the actions. `onSave` receives the trimmed note; the caller decides
// what an empty note means (the two sites differ).

export interface NoteComposer {
  el: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  focus(): void;
}

export function buildNoteComposer(opts: {
  placeholder?: string;
  extraClass?: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}): NoteComposer {
  const box = document.createElement("div");
  box.className = opts.extraClass ? `annotator-composer ${opts.extraClass}` : "annotator-composer";

  const ta = document.createElement("textarea");
  ta.className = "annotator-note";
  ta.placeholder = opts.placeholder ?? "Add a note…";
  ta.rows = 3;

  const actions = document.createElement("div");
  actions.className = "annotator-actions";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Save";
  actions.append(cancel, save);

  const fireSave = (): void => opts.onSave(ta.value.trim());
  save.addEventListener("click", fireSave);
  cancel.addEventListener("click", () => opts.onCancel());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      fireSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      opts.onCancel();
    }
  });

  box.append(ta, actions);
  return { el: box, textarea: ta, focus: () => ta.focus() };
}
