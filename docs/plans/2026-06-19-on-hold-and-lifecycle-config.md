# On-hold state + lifecycle config layering

Date: 2026-06-19

## Summary

Add a manual **on-hold** lane to the kanban board (park cards you'll come back to;
furled by default), and fix the architectural leak that would have made it worse:
orden's lifecycle states are baked into the "framework-agnostic" `@orden/outliner`
package. We extract the lifecycle into a proper layering — host-api holds the default
and consumes workflows; outliner/web/mcp receive the state set as a parameter — and
unify the duplicated `StageRole` (workflows) / `SessionState` (host-api) vocabularies
into one set of smartly-named primitives.

Related: `2026-06-17-configurable-workflows-consolidated.md` (workflow model + board
projection), `2026-06-17-default-workflow-two-framings.md` (the role/column mapping).

## Goals

1. **On-hold**: a manual-only, non-terminal lane, furled by default.
2. **Remove the lifecycle leak** from `@orden/outliner` (it should be a generic outliner).
3. **Establish the layering**: host-api defaults → consumer of workflows → params to
   outliner/web/mcp.
4. **Align the primitive vocabulary**: one `Lane` identity + one `Role` classification,
   not two competing enums.

## Non-goals

- Building the workflow board projection (role→lane runtime wiring). The seam is
  prepared, not wired.
- Persisting furl state across reloads (module-scoped, like board filters).
- Letting the agent set on-hold (intentionally manual-only).

## Naming alignment: Lane vs Role

Two concepts were conflated under two names:

- **Lane** — *where* a card is on the board. An **open** set (workflows can add custom
  lanes). The shared primitive.
- **Role** — *what a workflow step projects onto*. A **closed**, four-way classification
  for board projection.

Previously `StageRole` (workflows: `initial/active/waiting/terminal`) and `SessionState`
(host-api: `planning/in-progress/blocked/complete`) were two identities for the same four
board positions. We split the jobs:

- `StageRole` → **`Role`** (it was always a role; the rename stops it masquerading as the
  lane identity). `Step.role: Role`.
- **`Lane`** is the new shared identity. `SessionState` collapses into `Lane`.
  `Session.state: Lane`, `Card.state: Lane`.
- The 1:1 role↔lane map becomes explicit **data** (`roleByLane`) in the lifecycle config,
  not two parallel enums that happen to correspond.
- **Canonical lane members = operational words** (`planning/in-progress/blocked/complete/
  on-hold`): already what's stored in the vault (zero migration), what users see, and they
  scale when workflows add custom named lanes. The abstract role words survive — correctly
  scoped — as the `Role` members.
- `on-hold` is a `Lane` with `role: none` and `manual: true`: no step projects to it; it's
  the first non-role lane.

Why operational words win as the identity (and role words don't): the workflow design's
own critique (`two-framings.md:44` — "blocked is a state, not a step you author") is an
argument against the operational words doubling as **authoring units**, which Framing B
(the runbook) already solved by making the runbook the authoring unit. It is not an
argument against the operational words as **identities**. Keeping them as identities costs
zero data migration and reads naturally when the set is extended.

## Layering

```
@orden/workflows   Role, Lane, LaneDef, LifecycleConfig, DEFAULT_LIFECYCLE
                    (producer; the brain. Step.role: Role.)
       │ host-api consumes + re-exports (new dep; mirrors the existing host-api → chat-core dep)
       ▼
@orden/host-api    Session.state: Lane  (SessionState kept as a Lane alias for back-compat)
                    Host.lifecycle(): LifecycleConfig   ← new method; resolves the active
                    workflow's projection over the default
       │ passed as a parameter (never imported as a hardcoded constant)
       ▼
@orden/outliner    buildBoard<T>(cards, states), renderBoard(host, cards, opts)
                    — generic; never imports Lane. Keeps only generic grouping/render.
@orden/web         reads Lane + LifecycleConfig from host-api; passes states into the
                    outliner board fns; renders columns incl. the furled on-hold column.
@orden/mcp         CardRec.state: Lane; cardMove stays planning|in-progress|blocked
                    (the agent cannot hold a card).
apps/host          hooks generalize the complete-guard to a config-driven nonAutomatic set
                    (complete + on-hold + future workflow states).
```

Dependency direction: **`host-api → workflows`** (host-api is the consumer). host-api
re-exports the lifecycle types so downstream packages import them from host-api and never
touch workflows directly for this. The outliner's zero-orden-dependency invariant is
restored.

## The on-hold semantics

- **Manual-only.** Reachable by drag (board) or the state picker (card modal). NOT
  reachable by the agent (`cardMove` union unchanged) and NOT reachable by hooks
  (`on-hold` ∉ the hooks `ALLOWED` set).
- **Sticky.** The hook-driven auto-cycle must never release it. Today
  `applyState`/`applyStateBySessionId` hardcode `if (card.state === "complete") return;`.
  Generalize to `if (config.nonAutomatic.has(card.state)) return;` with default
  `nonAutomatic = {complete, on-hold}`. This is the exact seam the future workflow router
  will need.
- **Furled by default.** A module-scoped `Set<Lane>` seeded with `on-hold` (same survival
  pattern as board filters). A clickable column header toggles it. Not a needs-action
  lane (it's parked, not awaiting you). Never ages off.
- **Position:** rightmost real column (after Complete), before the derived Learnings
  column — a deferred pen, visually de-emphasized.

## What leaves the outliner

These are orden board POLICY, not generic outliner primitives — they move to host-api
(driven by the lifecycle config):

- `LIFECYCLE_ORDER`, `NEEDS_ACTION_STATES`, `COMPLETE_TTL_MS`
- `isExpiredComplete`, `needsActionCount`, `isNeedsAction`

`Card`/`Column` become generic `Card<T>`/`Column<T>` (stay in outliner). `CardState` (the
orden alias) is removed. The outliner's `renderBoard`/`buildBoard` were already unused by
the app (`apps/web/src/kanban.ts` re-implements rendering); they survive as generic
primitives for the demo.

## Change map (implementation order, bottom-up)

1. **workflows** — new `lifecycle.ts` (`Role`, `Lane`, `LaneDef`, `LifecycleConfig`,
   `DEFAULT_LIFECYCLE`); rename `StageRole`→`Role`, `STAGE_ROLES`→`ROLES`,
   `isStageRole`→`isRole` across the package; `Step.role: Role`.
2. **host-api** — add `@orden/workflows` dep; import + re-export the lifecycle types;
   `SessionState = Lane` alias; `Session.state: Lane`; add `Host.lifecycle()`; move the
   board-policy helpers here as config-driven functions.
3. **outliner** — generic `buildBoard<T>`/`renderBoard(host, cards, opts)`; delete the
   policy constants and `CardState`; generic `Card<T>`/`Column<T>`; update tests + demo.
4. **web** — import `Lane`/lifecycle from host-api; parameterize `kanban.ts`; collapse the
   duplicated local `STATE_LABELS` to the config's labels; add the on-hold column and
   furled-by-default; update `cardModal`/`newCardModal`/`issueList`/`projectPage`.
5. **host** — generalize the two complete-guards to the `nonAutomatic` set; confirm the
   idle reconciler only acts on `active` (it does — add a lock-in test).
6. **mcp** — `CardRec.state: Lane`; the `cardMove` union and HTTP fallback stay
   `planning|in-progress|blocked`.
7. **tests** — update outliner/workflows test assertions; add a hooks test that a Stop does
   not move an on-hold card; add a board test that on-hold renders furled and accepts drops.

## Open questions / follow-ups

- When workflows ship the role→lane projection at runtime, the router must skip held cards
  (the same `nonAutomatic` discipline) and shadow their role projection.
- Whether to persist column furl state in settings (today: ephemeral, like board filters).
- Whether `Host.lifecycle()` is per-session (resolves that session's workflow) or a single
  global default. First cut: global default; parameterize per-session when the workflow
  projection lands.
