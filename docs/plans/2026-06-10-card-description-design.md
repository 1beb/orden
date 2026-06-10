# Card description + new-card modal

Date: 2026-06-10. Mockups: `docs/mockups/add-bar-overlay-modal.html` (chosen),
`docs/mockups/add-bar-inline-morph.html` (rejected alternative).

## What

Cards gain a `description` — free text giving the agent more context than the
title alone. It is editable in the card modal and is sent to the agent together
with the title when a session starts on the card.

The project-page add bar grows a fast path for long thoughts: type a sentence,
type a period, keep typing — a **new-card modal** pops up pre-filled (first
sentence → title, the rest → description, cursor continuing in the description).
The bar itself stays a one-line input.

## Decisions (from review of live mockups)

- Modal variant, not inline morph: the split is visible and correctable; the
  page doesn't reflow under the list.
- Trigger: a sentence terminator (`.` `!` `?`) followed by whitespace and more
  text, on `input` (typing or paste). The terminator is stripped from the title.
- Dismiss is lossless: Escape / backdrop / ✕ put the joined text back in the
  add input. Cancel clears.
- Modal layout: title (header) → description → state/project/due at the bottom.
  Footer: Cancel / **Add** (not "Add card") + the agent launch marks, which add
  the card and immediately start a session on it.
- Mobile (≤860px, the app's existing breakpoint): the modal becomes a
  full-width bottom sheet, matching the annotations panel idiom.
- The existing card-detail modal gains the same Description section so the
  field stays editable after creation.

## How

- `cards.ts`: `Item.description?: string`; `addItem` takes an options object
  (`description`, `sessionId`); new `setItemDescription`.
- `thoughtSplit.ts` (new): `splitThought(text)` → `{title, description} | null`.
  No split when the period isn't followed by whitespace (so `v2.0` never
  splits).
- `newCardModal.ts` (new): the pre-filled create modal, reusing the
  `.preview-overlay` / `.preview-modal.card-modal` dress.
- `projectPage.ts` `addBar`: `input` listener opens the modal on a split;
  Enter/Add with splittable text routes through the modal too.
- `cardModal.ts`: Description section (writes through `setItemDescription`);
  meta row moves to the bottom for consistency with the create modal.
- `main.ts` `startSessionForItem`: `initialPrompt` becomes
  `title\n\ndescription` when a description exists (one helper,
  `promptForItem`, so the web and tests share it).
- MCP `tools.ts`: `card_get` includes `description`; `card_create` accepts an
  optional `description`.
- `styles.css`: `.card-modal__desc`, bottom-meta divider, and the ≤860px
  bottom-sheet rules for `.preview-modal.card-modal`.

Out of scope: showing the description on board cards / issue rows (the modal
is the read surface), description in annotation delivery, BrowserHost changes
(none needed — cards are vault records either way).
