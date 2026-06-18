/**
 * Deterministic markdown parser for a workflow file. Supports two body shapes:
 *   1. The runbook format (preferred): a numbered list of typed steps —
 *      `1. prose — Label`, `2. gate: approve — Label`, `3. do: push — Label`.
 *   2. The legacy heading format: `## Label` headings, each with prose body.
 * The numbered-list format carries the step kind (so it round-trips through the
 * validator); the heading format yields prose-only stages (the LLM compile step
 * turns those into typed steps). Frontmatter (`name`/`extends`/`description`) is
 * shared. This does NOT infer primitives from free prose — that is the compile.
 */

export type ParsedStepKind = "prose" | "primitive" | "gate";

export interface ParsedStage {
  label: string;
  prose: string;
  /** Step kind, present when the numbered-list runbook format carries a prefix. */
  kind?: ParsedStepKind;
  /** The action for a `primitive` step (e.g. `push`). */
  action?: string;
  /** The gate for a `gate` step (`approve` | `review`). */
  gate?: string;
}

export interface ParsedWorkflow {
  name?: string;
  extends?: string;
  description?: string;
  stages: ParsedStage[];
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function readFrontmatter(src: string): { rest: string; fields: Record<string, string> } {
  const m = src.match(FRONTMATTER);
  if (!m) return { rest: src, fields: {} };
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return { rest: src.slice(m[0].length), fields };
}

// A numbered runbook step: `<n>. <tag> — <label>` where tag is `prose`,
// `gate: <g>`, `do: <action>`, or `primitive: <action>`. The em dash may be `-`
// or `—`; the label is everything after it.
const RUNBOOK_STEP = /^\s*(?:\d+\.)\s+(prose|gate|do|primitive)(?::\s*(\S+))?\s*[—-]\s*(.+?)\s*$/;

export function parseWorkflowMarkdown(src: string): ParsedWorkflow {
  const { rest, fields } = readFrontmatter(src);
  const lines = rest.split("\n");

  // First pass: is this the numbered runbook format?
  const stepLines: { line: string; idx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (RUNBOOK_STEP.test(lines[i])) stepLines.push({ line: lines[i], idx: i });
  }

  if (stepLines.length > 0) {
    return { name: fields.name, extends: fields.extends, description: fields.description, stages: parseRunbook(lines, stepLines) };
  }

  // Legacy heading format.
  return { name: fields.name, extends: fields.extends, description: fields.description, stages: parseHeadings(lines) };
}

function parseRunbook(lines: string[], stepLines: { line: string; idx: number }[]): ParsedStage[] {
  const stages: ParsedStage[] = [];
  for (let s = 0; s < stepLines.length; s++) {
    const { line, idx } = stepLines[s];
    const m = line.match(RUNBOOK_STEP)!;
    const tag = m[1];
    const qualifier = m[2];
    const label = m[3];
    // The prose body is the indented lines until the next step line.
    const nextIdx = s + 1 < stepLines.length ? stepLines[s + 1].idx : lines.length;
    const body: string[] = [];
    for (let j = idx + 1; j < nextIdx; j++) {
      body.push(lines[j]);
    }
    const prose = body.join("\n").trim();
    const stage: ParsedStage = { label, prose };
    if (tag === "prose") {
      stage.kind = "prose";
    } else if (tag === "gate") {
      stage.kind = "gate";
      stage.gate = qualifier;
    } else {
      // `do` or `primitive`
      stage.kind = "primitive";
      stage.action = qualifier;
    }
    stages.push(stage);
  }
  return stages;
}

function parseHeadings(lines: string[]): ParsedStage[] {
  const stages: ParsedStage[] = [];
  let current: { label: string; body: string[] } | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) stages.push({ label: current.label, prose: current.body.join("\n").trim() });
      current = { label: heading[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) stages.push({ label: current.label, prose: current.body.join("\n").trim() });
  return stages;
}
