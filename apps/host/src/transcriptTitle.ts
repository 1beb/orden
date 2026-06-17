// Read Claude Code's OWN session title from its on-disk transcript. Used to
// title orden sessions with Claude's self-authored summary instead of "Untitled".
//
// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
// where <encoded-cwd> is the absolute cwd with every NON-alphanumeric char
// replaced by "-" — not just "/" and "." but "_" too (e.g.
// /home/b/projects/orden -> -home-b-projects-orden, and the underscore-laden
// worktree path /home/b/.orden/worktrees/proj_x_1/sess_y_2 ->
// -home-b--orden-worktrees-proj-x-1-sess-y-2). Verified against the real
// ~/.claude/projects directory on disk (Claude Code v2.1.x). Missing the "_"
// case made claudeTranscriptExists look in the wrong dir for every worktree
// session (their paths all carry proj_<id>/sess_<id>), so a resume could not
// find the transcript and buildCommand minted a brand-new conversation instead
// of reattaching to the ongoing one.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// The user's home, used to locate ~/.claude. Prefer the live $HOME env var over
// os.homedir(): on Linux they're identical (homedir() returns $HOME when set),
// but a directly-read env var is honored under test runners that set HOME at
// runtime, where the cached native homedir() is not.
const claudeHome = (): string => process.env.HOME || homedir();

// Has Claude actually written this session's transcript to disk yet? A
// conversationId is persisted at MINT time (the scoped MCP endpoint + state
// hooks bind to it before the agent runs), but Claude writes
// ~/.claude/projects/<encoded-cwd>/<id>.jsonl only once the session does real
// work. A session opened but never given a turn — or killed as untouched before
// its first turn — leaves the id pointing at a file that never existed. Callers
// use this to avoid `--resume`-ing a ghost conversation, which exits instantly.
export const claudeTranscriptExists = (cwd: string, sessionId: string): boolean => {
  try {
    return existsSync(
      join(claudeHome(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`),
    );
  } catch {
    return false;
  }
};

// Claude's own session title appears in the transcript as JSONL lines shaped
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}
// (There is NO "type":"summary" line in current Claude Code.) Verified on disk:
// the ai-title line is emitted by the INTERACTIVE entrypoint ("cli") — which is
// exactly how orden's TUI sessions run claude (real `claude --session-id` in
// tmux). It is rewritten as the session grows, so the last one wins. Returns
// null on any missing file/dir or parse issue — never throws.
export const readTranscriptTitle = (cwd: string, sessionId: string): string | null => {
  try {
    const file = join(claudeHome(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
    const raw = readFileSync(file, "utf8");
    let latest: string | null = null;
    for (const line of raw.split("\n")) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; aiTitle?: string };
        if (obj.type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle.trim()) {
          latest = obj.aiTitle.trim();
        }
      } catch {
        /* skip malformed line */
      }
    }
    return latest;
  } catch {
    return null;
  }
};

// Pull the first human prompt out of a transcript — the "what was this about"
// opening line. Claude Code stores user turns as
//   {"type":"user","message":{"role":"user","content":"..."|[{type:"text",text}]}}
// We take the first non-empty text turn, collapse whitespace, and cap length.
export const firstUserPrompt = (raw: string): string | null => {
  for (const line of raw.split("\n")) {
    if (!line.includes('"user"')) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (obj.type !== "user" || obj.message?.role !== "user") continue;
      const content = obj.message.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
          .join(" ");
      }
      text = text.replace(/\s+/g, " ").trim();
      // Skip tool-result / command envelopes that aren't a real human prompt.
      if (text && !text.startsWith("<")) return text.length > 200 ? `${text.slice(0, 197)}…` : text;
    } catch {
      /* skip malformed line */
    }
  }
  return null;
};

// Did the user actually submit a prompt in this session? Reads the transcript
// and reports whether it holds at least one real human turn. Used by the boot
// reconcile to protect a prompted-but-not-yet-titled session from being reaped
// as a dead "Untitled" stub. Returns false on any missing file / parse issue —
// the safe default (don't claim activity we can't see). Never throws.
export const readUserPrompt = (cwd: string, sessionId: string): string | null => {
  try {
    const file = join(claudeHome(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
    return firstUserPrompt(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// A short, mechanically-assembled session digest read straight off the
// transcript — NO `claude -p`, no agent turn. Combines Claude's own self-authored
// title (the ai-title line) with the opening human prompt. Returns null when the
// transcript is missing/unreadable so callers can fall back. Never throws.
export const readTranscriptSummary = (cwd: string, sessionId: string): string | null => {
  try {
    const file = join(claudeHome(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
    const raw = readFileSync(file, "utf8");
    const title = readTranscriptTitle(cwd, sessionId);
    const opening = firstUserPrompt(raw);
    if (title && opening) return `${title} — ${opening}`;
    return title ?? opening;
  } catch {
    return null;
  }
};
