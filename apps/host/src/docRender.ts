// Render a source doc (qmd/md/ipynb) to its artifact by shelling out to quarto.
// Used by the learnings surface to turn an agent-authored writeup into a viewable
// HTML page. The actual child process is INJECTABLE so the parse/resolve logic is
// unit-testable without a real quarto binary on PATH.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve, extname, basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export interface RenderResult {
  ok: boolean;
  outputPath?: string; // absolute path to the rendered artifact, on success
  errors?: string; // stderr/stdout summary, on failure
}

// Abstracts the child process. Given the absolute source path, run the renderer
// and report its captured streams + exit code (0 = success).
export type RenderRunner = (
  absSourcePath: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

// Default runner: `quarto render <abs>` from the source's directory. Quarto
// rejects (throws) on a non-zero exit, so we catch and pull code/stdout/stderr
// off the error object. Kept thin — the injected runner is what's tested.
const defaultRunner: RenderRunner = async (absSourcePath) => {
  try {
    const { stdout, stderr } = await execFileAsync("quarto", ["render", absSourcePath], {
      cwd: dirname(absSourcePath),
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
};

// Pull the artifact path out of quarto's stdout. Quarto prints
//   Output created: <path>
// where <path> is RELATIVE to the source's directory. Resolve it against that
// directory to an absolute path (an already-absolute path resolves to itself).
function parseOutputPath(stdout: string, absSourcePath: string): string | null {
  const m = stdout.match(/^Output created:\s*(.+)$/m);
  if (!m) return null;
  return resolve(dirname(absSourcePath), m[1].trim());
}

// Fallback artifact when quarto didn't print an Output line: swap the source
// extension for .html in the same directory (/repo/doc.qmd -> /repo/doc.html).
function swapToHtml(absSourcePath: string): string {
  const dir = dirname(absSourcePath);
  const base = basename(absSourcePath, extname(absSourcePath));
  return join(dir, `${base}.html`);
}

/**
 * Render `absSourcePath` (an ABSOLUTE path) with quarto and resolve a result.
 * On success, `outputPath` is the absolute artifact path parsed from quarto's
 * stdout (or an extension-swap fallback). On failure, `errors` is a trimmed
 * stderr/stdout summary. Pass `run` to inject a fake runner in tests.
 */
export async function renderDoc(
  absSourcePath: string,
  run: RenderRunner = defaultRunner,
): Promise<RenderResult> {
  const { stdout, stderr, code } = await run(absSourcePath);

  if (code !== 0) {
    const errors = (stderr.trim() || stdout.trim()).trim();
    return { ok: false, errors };
  }

  const outputPath = parseOutputPath(stdout, absSourcePath) ?? swapToHtml(absSourcePath);
  return { ok: true, outputPath };
}
