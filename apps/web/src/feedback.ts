// Builds the human-readable payload that gets handed to an agent or a person.
// This is the "see how it will be passed" surface — keep it legible.

export interface FeedbackItem {
  ref: string; // the exact quoted text
  prefix: string; // a little context before
  suffix: string; // a little context after
  note: string; // the reviewer's comment
}

export function buildFeedbackPayload(opts: {
  title: string;
  target: "agent" | "human";
  items: FeedbackItem[];
}): string {
  const { title, target, items } = opts;
  const n = items.length;
  const lines: string[] = [];
  lines.push(`Review feedback — ${title}`);
  lines.push(`Recipient: ${target}`);
  lines.push(`${n} comment${n === 1 ? "" : "s"}.`);
  lines.push("");

  items.forEach((it, i) => {
    const context = `${it.prefix}「${it.ref}」${it.suffix}`.replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. ${context}`);
    lines.push(`   → ${it.note}`);
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}
