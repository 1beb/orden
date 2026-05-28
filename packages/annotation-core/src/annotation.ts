import type { Annotation, Anchor, FeedbackTarget } from "./types";

let counter = 0;

export function createAnnotation(input: {
  anchor: Anchor;
  body: string;
  target?: FeedbackTarget;
}): Annotation {
  counter += 1;
  return {
    id: `ann_${Date.now().toString(36)}_${counter}`,
    anchor: input.anchor,
    body: input.body,
    target: input.target ?? "agent",
    status: "open",
    thread: [],
    createdAt: new Date().toISOString(),
  };
}
