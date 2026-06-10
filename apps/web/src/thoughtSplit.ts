// Split a free-typed thought into a card title + description: the first
// completed sentence (terminated by . ! ? and followed by whitespace + more
// text, or ended by a newline) becomes the title, the rest the description.
// A terminator NOT followed by whitespace never splits, so "v2.0" stays whole.
// Returns null when there is no boundary — the text is just a title.

export interface ThoughtSplit {
  title: string;
  description: string;
}

const BOUNDARY = /^([\s\S]*?)(?:[.!?][ \t]+|[.!?]?\n+)(\S[\s\S]*)$/;

export function splitThought(text: string): ThoughtSplit | null {
  const m = BOUNDARY.exec(text);
  if (!m) return null;
  const title = m[1].trim();
  const description = m[2].trim();
  if (!title || !description) return null;
  return { title, description };
}
