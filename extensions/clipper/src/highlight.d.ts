// Ambient declarations for the CSS Custom Highlight API, which TypeScript's
// bundled DOM lib (as configured here) does not yet expose. We paint clipper
// annotation marks with `CSS.highlights` + `::highlight()` rather than mutating
// the live page DOM, so these types are required.

declare class Highlight {
  constructor(...initialRanges: Range[]);
  add(range: Range): void;
  delete(range: Range): void;
  clear(): void;
}

interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
  has(name: string): boolean;
  clear(): void;
}

declare namespace CSS {
  const highlights: HighlightRegistry;
}
