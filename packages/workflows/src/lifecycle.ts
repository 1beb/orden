/**
 * The lifecycle model — the shared primitive vocabulary for where a card/session
 * sits on the board. See docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
 *
 * Two concepts, deliberately separated (previously conflated under two names):
 *   - Role  — what a workflow STEP projects onto (closed, four-way; for board
 *             projection). Every runbook projects onto these four.
 *   - Lane  — where a card IS (the identity; an OPEN set — workflows can declare
 *             custom lanes, and on-hold is a manual, non-role lane).
 *
 * `Role` is the renamed `StageRole`. `Lane` is the new shared identity that the
 * old `SessionState` collapses into. The 1:1 role<->lane map is explicit DATA in
 * `LifecycleConfig.roleByLane`, not two parallel enums that happen to correspond.
 *
 * This package is the producer; @orden/host-api consumes it (host-api holds the
 * default at runtime and re-exports these types so downstream never imports this
 * package for the lifecycle vocabulary).
 */

/**
 * What a workflow step projects onto — the closed, four-way classification that
 * drives board projection. Because every runbook projects onto these four roles,
 * one board can show cards running different workflows without confusion.
 */
export type Role = "initial" | "active" | "waiting" | "terminal";

/**
 * The default lane set: orden's standard four lifecycle lanes plus the manual
 * on-hold lane. Concrete (for type-safety at the host-api boundary); the
 * `LifecycleConfig` below is keyed by `string` so a workflow can declare more.
 */
export const DEFAULT_LANES = [
  "planning",
  "in-progress",
  "blocked",
  "complete",
  "on-hold",
] as const;

/** The concrete default lane identity (type-safe at boundaries). */
export type DefaultLane = (typeof DEFAULT_LANES)[number];

/**
 * A lane's definition: its identity plus the projection/behavior metadata orden
 * layers on top. `role` is the board-projection classification (absent for
 * manual lanes like on-hold that no step projects onto). `label` is the display
 * word — layered on top of the identity, never baked into it.
 */
export interface LaneDef {
  lane: string;
  /** Display label, e.g. "In-progress". Presentation, not identity. */
  label: string;
  /** Which Role this lane projects onto; absent for non-role (manual) lanes. */
  role?: Role;
  /**
   * Manual-only lanes: reachable by the user (drag, picker), never by the agent
   * or the hook-driven auto-cycle. on-hold is the first.
   */
  manual?: boolean;
}

/**
 * Board policy layered on the lane set — all orden app-level policy lives here
 * (NOT in the generic @orden/outliner). host-api serves a resolved instance
 * (the default, or the default merged with the active workflow's extensions) and
 * passes it down to outliner/web/mcp as a parameter.
 */
export interface LifecycleConfig {
  /** Lane display order, left to right. */
  order: string[];
  /** Per-lane definitions, keyed by lane identity. */
  lanes: Record<string, LaneDef>;
  /** Lanes that feed the nav "needs action" badge. */
  needsAction: string[];
  /** Lanes rendered collapsed until the user opens them. */
  furledByDefault: string[];
  /**
   * Lanes the hook-driven auto-cycle must NEVER move a card out of (terminal +
   * manual). Hooks skip any card already in one of these — so once a card is
   * complete or on-hold, only a deliberate user/agent action moves it. The
   * future workflow router reuses this same discipline for its own states.
   */
  nonAutomatic: string[];
  /** Dwell time (ms) before a complete card falls off the board. */
  completeTtlMs: number;
}

/** Default dwell time before a completed card drops off the board/list. */
export const COMPLETE_TTL_MS = 60 * 60 * 1000;

/**
 * The default lifecycle: orden's standard four lanes (planning -> in-progress ->
 * blocked -> complete) plus the manual on-hold lane. With no workflow chosen,
 * host-api serves this. A workflow extends it by declaring extra lanes (and
 * their roles); host-api merges the two. on-hold is manual, has no role, is
 * furled by default, and is non-automatic.
 */
export const DEFAULT_LIFECYCLE: LifecycleConfig = {
  order: [...DEFAULT_LANES],
  lanes: {
    planning: { lane: "planning", label: "Planning", role: "initial" },
    "in-progress": { lane: "in-progress", label: "In-progress", role: "active" },
    blocked: { lane: "blocked", label: "Blocked", role: "waiting" },
    complete: { lane: "complete", label: "Complete", role: "terminal" },
    "on-hold": { lane: "on-hold", label: "On hold", manual: true },
  },
  needsAction: ["blocked"],
  furledByDefault: ["on-hold"],
  nonAutomatic: ["complete", "on-hold"],
  completeTtlMs: COMPLETE_TTL_MS,
};
