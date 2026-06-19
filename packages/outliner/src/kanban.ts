import type { Card, Column } from "./types";

/**
 * Group cards into one column per lane, in the caller's chosen order. Generic
 * over the lane key `T`: orden passes its `Lane` set (from @orden/host-api); a
 * generic consumer passes any string key. The outliner carries no opinion about
 * which lanes exist or their order — that is received as a parameter.
 *
 * See docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
 */
export function buildBoard<T extends string>(
  cards: Card<T>[],
  states: readonly T[],
): Column<T>[] {
  return states.map((state) => ({
    state,
    cards: cards.filter((c) => c.state === state),
  }));
}
