const WIKI_LINK_RE = /\[\[([^\[\]]+?)\]\]/g;

/**
 * Extract `[[wiki link]]` targets from a block's text, in document order,
 * de-duplicated and whitespace-trimmed. Empty links are ignored.
 */
export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(WIKI_LINK_RE)) {
    const target = match[1].trim();
    if (target.length === 0) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}
