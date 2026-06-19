// The web's single read of the lifecycle config. All lane / order / label / board
// policy consumption funnels through here so the board, the list view, and the card
// modal never duplicate the vocabulary (the old per-file STATE_LABELS copies) and
// never hardcode a lane. First cut reads the global DEFAULT_LIFECYCLE; when the
// workflow board projection lands this becomes host.lifecycle()-driven (per card).
// See docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
import { DEFAULT_LIFECYCLE } from "@orden/host-api";

/** Lane display order, left to right (the board columns, minus web-local derived ones). */
export const LANE_ORDER: readonly string[] = DEFAULT_LIFECYCLE.order;

/** Display label per lane identity (presentation, layered on top of the identity). */
export const LANE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(DEFAULT_LIFECYCLE.lanes).map(([lane, def]) => [lane, def.label]),
);

/** Lanes that feed the nav "needs action" badge. */
export const NEEDS_ACTION_LANES: ReadonlySet<string> = new Set(
  DEFAULT_LIFECYCLE.needsAction,
);

/** Lanes rendered collapsed until the user opens them (on-hold is furled by default). */
export const FURLED_BY_DEFAULT: ReadonlySet<string> = new Set(
  DEFAULT_LIFECYCLE.furledByDefault,
);

/**
 * Lanes the hook-driven auto-cycle must never move a card out of (terminal +
 * manual). The web doesn't drive hooks, but reflects this set where it matters
 * (e.g. a held card isn't "needs action" even if it has open sessions).
 */
export const NON_AUTOMATIC_LANES: ReadonlySet<string> = new Set(
  DEFAULT_LIFECYCLE.nonAutomatic,
);

/** Dwell time (ms) before a complete card falls off the board. */
export const COMPLETE_TTL_MS: number = DEFAULT_LIFECYCLE.completeTtlMs;
