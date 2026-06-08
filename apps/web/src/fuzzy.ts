// A small subsequence fuzzy scorer. Higher score = better. null = no match.
// Heuristic: each matched char scores 1; consecutive matches and matches at a
// word boundary / string start get a bonus, so contiguous and prefix hits rank
// above scattered ones. Case-insensitive.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 3; // contiguous run
    else if (found === 0 || /\s|[/_-]/.test(t[found - 1])) score += 2; // boundary
    prevMatch = found;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 2; // whole-query prefix of the text
  return score;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keyFn: (item: T) => string,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, keyFn(item));
    if (score !== null) out.push({ item, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
