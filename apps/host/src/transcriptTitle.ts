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
