import type {
  OrdenAnnotation,
  OrdenAudience,
  Selector,
  Source,
} from "./wadm";

let counter = 0;

export function createOrdenAnnotation(input: {
  source: Source;
  selector: Selector | Selector[];
  body: { text: string; tags?: string[]; color?: string };
  creator: { kind: "human" | "agent"; id: string };
  audience?: OrdenAudience;
}): OrdenAnnotation {
  counter += 1;
  return {
    id: `ann_${Date.now().toString(36)}_${counter}`,
    created: new Date().toISOString(),
    creator: input.creator,
    target: { source: input.source, selector: input.selector },
    body: input.body,
    "orden:status": "open",
    "orden:audience": input.audience ?? "agent",
    "orden:thread": [],
  };
}
