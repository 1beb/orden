# New-card form: in-situ expansion + control consistency

Date: 2026-06-10. Follow-up to the add-bar new-card modal
(2026-06-09 card description + new-card modal).

## Problems

1. The modal's Add button (`.dialog__btn--primary`, padding 7px 14px) is a
   different size than the add bar's Add button (`.project-add-btn`, 7px 16px).
2. The Claude/opencode launch marks sit top-aligned in `.dialog__actions`
   (no `align-items`), so the 22px round marks float above the text buttons'
   centerline.
3. The form opens as a screen-centered modal, visually disconnected from the
   add input the thought was typed into.

## Design

### Control consistency

- `.dialog__btn` padding becomes 7px 16px, matching `.project-add-btn`
  (confirm dialogs pick this up too — one button size everywhere).
- `.dialog__actions` gets `align-items: center` so the agent marks sit on the
  buttons' centerline.

### In-situ expansion

The form grows out of the add bar instead of centering — an in-place overlay
anchored to the input, like a modal but not centered.

- `openNewCardModal` gains an optional `anchor` element (the add-bar row,
  passed by `projectPage.addBar`). No anchor (or an unmeasurable one, e.g. in
  happy-dom tests) falls back to the current centered modal.
- With an anchor (the add input), the overlay keeps the fixed backdrop
  (Esc / backdrop click still dismiss-and-restore) but drops the flex
  centering and lightens the dim, and the panel is positioned absolutely so
  the DESCRIPTION textarea lands exactly on the input — same box, same text
  metrics (the in-situ desc matches the input's 14px font and 7px/10px
  padding), so the typed text stays put and the form grows around it:
  - modal left/top = anchor minus the description's offsets inside the modal;
  - modal width = anchor width plus the chrome around the description.
- Animation: the panel renders at full size but `clip-path`-clipped to the
  input's box, then the clip expands outward (~200ms ease) while the title
  rises out of the input into the header (translateY + fade) and the
  remaining controls (section head, hint, meta, actions) fade in slightly
  delayed. On `transitionend` the clip is removed. Capped to the viewport;
  the body scrolls past the cap. `prefers-reduced-motion` disables all of it.

No reverse animation on close; dismissal already restores the text to the
input instantly.

## Testing

Existing newCardModal tests keep passing (no anchor → centered fallback).
New tests stub `getBoundingClientRect` on an anchor to assert the in-situ
classes and positioning apply, and that the no-anchor path stays centered.
Visual verification via the running app.
