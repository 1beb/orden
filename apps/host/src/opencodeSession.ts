// Read opencode's OWN session id + title from its session store, so orden can
// resume an opencode TUI session across tmux lifetimes and title it like Claude.
//
// Unlike Claude (per-session JSONL files under ~/.claude/projects/<enc>/<id>.jsonl),
// opencode v1.x stores sessions in a SQLite db (~/.local/share/opencode/opencode.db).
// The pre-Feb-2026 on-disk JSON files under storage/session/ are no longer written,
// so reading those directly is unreliable. Instead we shell out to the opencode CLI,
// which is the version-stable, db-backed interface:
//
//   opencode session list --format json [-n N]
//     -> [{ id, title, updated, created, projectId, directory }, ...]  (newest first)
//
// Verified against opencode 1.15.12 on disk. Both helpers run the CLI with a short
// timeout and return null on any failure — they never throw.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAgentBin } from "./agentBin";

const exec = promisify(execFile);

interface OpencodeSession {
  id: string;
  title?: string;
  updated?: number;
  created?: number;
  projectId?: string;
  directory?: string;
}

// opencode auto-assigns a placeholder title ("New session - <ISO timestamp>") at
// creation and replaces it with a real summary once the model has context. Treat
// the placeholder as "still untitled" so the poller keeps waiting for the real one.
const isPlaceholderTitle = (t: string): boolean => /^New session - /.test(t.trim());

// List recent opencode sessions (newest first) via the CLI's JSON output. Returns
// [] on any failure. `max` caps the query (the CLI's -n) to keep it cheap.
async function listSessions(cwd: string, max = 25): Promise<OpencodeSession[]> {
  try {
    const { stdout } = await exec(
      resolveAgentBin("opencode"),
      ["session", "list", "--format", "json", "-n", String(max)],
      { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as OpencodeSession[]) : [];
  } catch {
    return [];
  }
}

// Find the session id opencode created for a freshly-launched TUI in `cwd`. We
// can't pre-mint an id the way Claude allows (the TUI has no --session-id; -s only
// RESUMES an existing one), so after launching bare `opencode` we discover the id
// it minted: the newest session whose directory matches cwd. Pass `exclude` (the
// set of ids that already existed in cwd BEFORE launch) to avoid grabbing a stale
// session when discovery races a slow TUI startup. Returns null if none yet.
export async function discoverOpencodeSession(
  cwd: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const sessions = await listSessions(cwd);
  for (const s of sessions) {
    if (s.directory === cwd && s.id && !exclude.has(s.id)) return s.id;
  }
  return null;
}

// Snapshot the session ids that already exist for `cwd` (used as `exclude` above
// so post-launch discovery only picks up the session opencode just created).
export async function existingOpencodeSessions(cwd: string): Promise<Set<string>> {
  const sessions = await listSessions(cwd);
  return new Set(sessions.filter((s) => s.directory === cwd && s.id).map((s) => s.id));
}

// Check that an opencode session ID still lives in the given cwd — the directory
// field must match. Used as a guard before resuming, so a stale conversationId
// (e.g. discovered in the shared repo before worktree isolation was on) doesn't
// silently resume an unrelated session.
export async function opencodeSessionInCwd(cwd: string, sessionId: string): Promise<boolean> {
  const sessions = await listSessions(cwd);
  return sessions.some((s) => s.id === sessionId && s.directory === cwd);
}

// Read the real (non-placeholder) title for a known opencode session id. Returns
// null if the session is gone, still has its placeholder "New session - ..." title,
// or the title is empty — i.e. "no usable title yet".
export async function readOpencodeTitle(cwd: string, sessionId: string): Promise<string | null> {
  const sessions = await listSessions(cwd);
  const match = sessions.find((s) => s.id === sessionId);
  const title = match?.title?.trim();
  if (!title || isPlaceholderTitle(title)) return null;
  return title;
}
