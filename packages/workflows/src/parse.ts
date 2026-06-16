/**
 * Deterministic markdown parser for a workflow file. Headings (`## `) are stages, in
 * order; the prose under each is the operator's description. This does NOT infer
 * primitives — turning prose into a WorkflowSpec is the LLM compile step (Stage 3).
 */

export interface ParsedStage {
  label: string;
  prose: string;
}

export interface ParsedWorkflow {
  name?: string;
  extends?: string;
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

export function parseWorkflowMarkdown(src: string): ParsedWorkflow {
  const { rest, fields } = readFrontmatter(src);
  const stages: ParsedStage[] = [];

  // Split on level-2 headings, keeping each heading with its following body.
  const lines = rest.split("\n");
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

  return {
    name: fields.name,
    extends: fields.extends,
    stages,
  };
}
