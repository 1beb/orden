export interface TextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  start: number;
  end: number;
}

export interface Anchor {
  blockId: string;
  quote?: TextQuoteSelector;
  position?: TextPositionSelector;
}

export type FeedbackTarget = "agent" | "human";
export type AnnotationStatus = "open" | "sent" | "resolved";

export interface AnnotationReply {
  author: "user" | "agent";
  body: string;
  createdAt: string;
}

export interface Annotation {
  id: string;
  anchor: Anchor;
  body: string;
  target: FeedbackTarget;
  status: AnnotationStatus;
  thread: AnnotationReply[];
  createdAt: string;
}
