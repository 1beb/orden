# Keyboard shortcuts + help panel

Date: 2026-06-10. Status: approved (sections validated in session).

## Goal

A coherent, user-adjustable keyboard shortcut scheme for the web app, plus a
help (?) view — opened from a new `?` button at the right end of the nav
footer — that both documents the bindings and lets the user rebind them.

## Shortcut map (defaults)

`mod` = Ctrl on Linux/Windows, Cmd on mac. Chords are stored layout-independent
(derived from `KeyboardEvent.code`, not `key`, so `Shift` can't mutate the key
token).

Layout:

| Action id | Default | Effect |
|---|---|---|
| `nav.toggle` | `mod+\` | Toggle left nav (pre-existing binding, folded in) |
| `sessions.toggle` | `mod+.` | Toggle the right session pane (Slack right-sidebar convention) |
| `context.toggle` | `mod+'` | Toggle the context panel (outline + annotations together) |
| `focus.toggle` | `mod+shift+\` | Focus mode: hide nav + context panel + sessions; press again to restore the prior layout |

Search and commands (pre-existing, folded into the table so they are
documented and rebindable):

| `search.open` | `mod+k` | Omnisearch |
| `palette.open` | `mod+shift+p` | Command palette (">" mode) |

Help and settings:

| `help.toggle` | `mod+/` and `?` | Toggle the help view (`?` only when not typing) |
| `settings.toggle` | `mod+,` | Toggle the settings view (universal preferences key) |

Non-rebindable, shown in help as reference: `Esc` (close help / settings /
modals / palette), editor keys (`mod+z/y`, `tab` / `shift+tab`, `mod+[` /
`mod+]`), `mod+enter` (save annotation note).

Deliberately excluded: `mod+1/2/3` view switching (browsers own Ctrl+digit),
`mod+b/i` (reserved for future bold/italic), per-block outline/annotation keys
(palette commands cover them), Gmail-style `g` navigation chords (deferred).

## Keybinding model (`apps/web/src/keybindings.ts`)

- An **action** = `{ id, label, group, defaults: string[] }` plus a handler
  registered by `main.ts`. An action may have several chords (help has two);
  rebinding replaces them with one.
- **Chord normalization**: `KeyboardEvent.code` → canonical token (`KeyK`→`k`,
  `Backslash`→`\`, `Period`→`.`, `Quote`→`'`, `Comma`→`,`, `Slash`→`/`), with
  modifiers `mod`/`shift`/`alt` sorted into a canonical string like
  `"mod+shift+\"`. `mod` matches Ctrl on non-mac, Cmd on mac.
- **Overrides** live in the vault: ns `settings`, key `keybindings`, value
  `{ [actionId]: string[] }` — only deviations from defaults, so future default
  changes reach existing vaults. Hydrate-at-boot + sync cache + write-through,
  like every other store; the `settings` change-feed case rehydrates so a
  rebind in one window lands in others.
- **Dispatcher**: one document-level `keydown` listener. Modifier chords fire
  everywhere; modifier-less chords (`?`) are suppressed while typing (input,
  textarea, contenteditable/ProseMirror, xterm).
- The existing inline handlers (`mod+\` in main.ts, `mod+k`/`mod+shift+p` near
  the palette) are removed and re-registered through this module.

## Focus mode

`focus.toggle` snapshots current visibility (nav open/closed, session pane,
outline hidden, annotations hidden), then closes all of them. Pressing it again
restores the snapshot. Any individual pane toggle (key, topbar button, footer
button) while a snapshot is pending simply drops the snapshot — focus mode
exits implicitly, no sticky state.

## Terminal pass-through

xterm currently consumes every key when focused. `terminalView.ts` gets an
`attachCustomKeyEventHandler` that declines (returns false, letting the event
bubble to the dispatcher) any **bound** chord that carries `mod` plus either
`shift` or a punctuation key — i.e. all layout/help/settings chords, including
`mod+\` (which would otherwise SIGQUIT the agent). Plain `mod+letter` chords
(`mod+k`) stay with the terminal, since TUIs use Ctrl+letter heavily
(readline kill-line etc.). `?` and `shift+/` always reach the terminal.

## Help view (`apps/web/src/helpView.ts`)

- A new main-panel view `help` (View union + `#view-help` section styled like
  the settings page), toggled by `help.toggle`, the new `?` footer button
  (after the cog), and `Esc` — open/close mirrors the settings cog exactly,
  returning to the pre-help view.
- Renders the actions grouped (Layout / Search / Help & settings) as rows:
  label + `kbd` chips of the current chords, plus a fixed reference section
  (Esc, editor keys) that is display-only.
- **Rebinding**: click a row → it enters recording state ("Press a shortcut,
  Esc cancels"); the next non-modifier keydown is captured (capture phase,
  stopped). Conflict with another action shows an inline warning and stays
  recording; otherwise the override persists to the vault and the row
  re-renders. Overridden rows get a per-row Reset; a footer "Reset all" clears
  the vault key.

## Testing

Pure-function tests (`apps/web/test/keybindings.test.ts`): event → chord
normalization (code-based, shift-mutation cases), matching with mac/non-mac
`mod`, defaults/overrides merge, conflict detection, display formatting
(`shift+/` renders as `?`, mac glyphs). Help-view test: renders rows, records
a rebind, refuses a conflicting chord, resets an override.
