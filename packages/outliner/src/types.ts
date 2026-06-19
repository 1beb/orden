/** A single bullet in the outline. */
export interface Block {
  id: string;
  text: string;
  collapsed: boolean;
  children: Block[];
}

/** A named outline. The daily journal is just pages keyed by an ISO date. */
export interface Page {
  /** Stable key. For journal pages this is an ISO date, e.g. "2026-05-28". */
  name: string;
  root: Block;
}

/**
 * A generic board card. `T` is the lane/state key the caller groups by — orden
 * passes its `Lane` set (from @orden/host-api), a generic consumer passes any
 * string key. The outliner carries NO opinion about which lanes exist; that is
 * orden board policy received as a parameter. See
 * docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
 */
export interface Card<T extends string = string> {
  id: string;
  title: string;
  state: T;
}

/** A board column: one lane key plus the cards in it. */
export interface Column<T extends string = string> {
  state: T;
  cards: Card<T>[];
}
