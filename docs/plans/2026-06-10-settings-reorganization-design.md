# Settings reorganization design

Date: 2026-06-10

## Problem

The settings view (`apps/web/index.html` `#view-settings`) grew by accretion into six
groups whose membership no longer tracks what the settings do: session-pane width (a
layout knob) sits under "Startup & Layout", completed-card fade (a purely visual knob)
under "Sessions & Board", and three groups hold exactly one item each (Documents,
Journal, Vault). Within a group, bare checkboxes, native selects, radio lists, and
range sliders are stacked vertically with no shared row structure, so mixed control
types read as visual noise.

## Decision

Pure UI reorganization: regroup the existing settings and normalize every control's
presentation. No changes to the settings model — `settings.ts` keys, defaults, and
coercion are untouched, so stored vaults need no migration.

### Groups (four, ordered by touch frequency)

1. Appearance — Font, Text size, Accent color, Completed tasks fade (moved here:
   it controls how cards look, not how sessions behave).
2. Layout — On startup show, Session pane width.
3. Sessions — Auto-launch, Worktree isolation, Default session mode, PRs on
   completion, Terminal-only button, Show archived.
4. General — Render HTML, Journal time zone, Vault location (absorbs the three
   single-item groups).

### Row anatomy

Every setting is one `.settings-row`: label on the left, control right-aligned,
consistent min-height. Sliders show their live value beside the control.

### Control normalization

- Booleans (6) → toggle switches. Still `<input type="checkbox">` with the same ids
  underneath; the switch is a CSS restyle, so `main.ts` wiring is unchanged.
- Small enums → segmented controls built on radio inputs:
  - startup (Journal / Kanban / Last) keeps its existing radio name and values;
  - completed-fade (1h / 4h / 8h / 24h) changes from a `<select>` to radios — the one
    `main.ts` wiring change;
  - default session mode (TUI / GUI per tool) restyles the existing mode grid cells
    as segments.
- Long enums (Font, PRs on completion, Time zone) stay native selects, styled
  consistently.
- Sliders stay `<input type="range">`.

## Files touched

- `apps/web/index.html` — restructure `#view-settings` markup.
- `apps/web/src/styles.css` — `.settings-row`, `.settings-switch`, `.settings-seg`
  styles; retire per-control one-off layouts.
- `apps/web/src/main.ts` — fade select→radio wiring; no other logic changes.
- `apps/web/src/modeGrid.ts` (or wherever `buildModeGrid` lives) — emit segment
  markup instead of a table.

## Out of scope

`kanbanView` and `worktreeBaseRef` remain non-UI settings (toggled in the kanban view
and per-project page respectively). No new settings are added.
