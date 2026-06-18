# ADR-0017: Curated claude model catalog over dynamic SDK probe

**Date:** 2026-06-17
**Status:** accepted

## Context

The Settings → Sessions default-model picker needs a list of selectable models per
agent harness. The **opencode** adapter populates its dropdown dynamically — it
connects to opencode's HTTP API and calls `config.providers()`, because the set of
models genuinely depends on the user's configured providers (truly runtime data).

For **claude**, two strategies were considered. PR #14 (`c2de9a7`, later superseded)
replaced the hardcoded `CLAUDE_MODELS` catalog with a dynamic probe: open a
short-lived SDK `query` just to call `q.supportedModels()`, with a 5-second timeout
and an empty-list fallback. An independent reimplementation on main (`43cb1f7`)
kept a curated `CLAUDE_MODELS` array of five ids instead.

The "consistency" argument — both adapters dynamic — makes the dynamic probe
tempting. This ADR records why we keep curated for claude.

## Decision

**Claude's model list is a curated static array (`CLAUDE_MODELS` in
`apps/host/src/chat/adapters/claude.ts`); we do NOT probe the SDK at list time.**

Rationale:

1. **The claude-agent-sdk is a pinned dependency** (`^0.2.126`). A model's existence
   is fixed by the SDK release we ship against — it is static data, not runtime data.
   The curated list therefore tracks the SDK release, which is a natural, reviewable
   update cadence (bump the SDK → one-line edit to the array in the same change).
2. **No failure mode.** The dynamic probe returns `[]` on SDK timeout or a
   missing/hung claude binary — an empty dropdown on a settings page is confusing.
   Curated always renders. It also avoids the 5s latency the probe adds to opening
   Settings.
3. **Test precision.** The dynamic probe hits the real SDK, which forced PR #14 to
   weaken `listModels` assertions in `nodeHost`/`rpc` tests down to bare
   `Array.isArray` checks. Curated keeps exact assertions.
4. **The opencode analogy doesn't hold.** opencode's models are user-configured
   providers — genuinely dynamic config — so a dynamic probe is the honest
   representation there. Claude's models are fixed by the SDK release, so a static
   list is the honest representation here. The two adapters being asymmetric is
   correct, not a smell.
5. **[1m] context variants get stable, human-authored labels** (e.g. "Claude Opus
   4.8 (1M context)") rather than whatever `displayName` the SDK returns.

## Consequences

**Easier:**
- Settings always renders a populated claude dropdown; no timeout, no empty state.
- Host tests stay exact (`claude.adapter.test.ts` asserts the curated set incl. a
  `[1m]` variant).
- No SDK process is spawned just to enumerate models.

**Harder:**
- The curated list can go stale if a new model ships and the array isn't updated.
  Mitigated by keeping the list adjacent to the SDK dependency bump (same review).
- Future harnesses whose models ARE genuinely runtime-configured should still use a
  dynamic probe — this decision is claude-specific, not a blanket rule.

**Revisit if:** claude starts shipping models faster than SDK releases are reviewed,
or a single dynamic mechanism for all harnesses is explicitly desired.
