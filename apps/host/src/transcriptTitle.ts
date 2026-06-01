// Read Claude Code's OWN session title from its on-disk transcript. Used to
// title orden sessions with Claude's self-authored summary instead of "Untitled".
//
// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
// where <encoded-cwd> is the absolute cwd with every "/" and "." replaced by "-"
// (e.g. /home/b/projects/orden -> -home-b-projects-orden). Verified against the
// real ~/.claude/projects directory on disk (Claude Code v2.1.x).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const encodeCwd = (cwd: string): string => cwd.replace(/[/.]/g, "-");

// Claude's own session title appears in the transcript as JSONL lines shaped
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}
// (There is NO "type":"summary" line in current Claude Code.) Verified on disk:
// the ai-title line is emitted by the INTERACTIVE entrypoint ("cli") — which is
// exactly how orden's TUI sessions run claude (real `claude --session-id` in
// tmux). It is rewritten as the session grows, so the last one wins. Returns
// null on any missing file/dir or parse issue — never throws.
export const readTranscriptTitle = (cwd: string, sessionId: string): string | null => {
  try {
    const file = join(homedir(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
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
    const file = join(homedir(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
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
    const file = join(homedir(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
    const raw = readFileSync(file, "utf8");
    const title = readTranscriptTitle(cwd, sessionId);
    const opening = firstUserPrompt(raw);
    if (title && opening) return `${title} — ${opening}`;
    return title ?? opening;
  } catch {
    return null;
  }
};
