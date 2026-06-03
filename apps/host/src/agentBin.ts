// Resolve an agent CLI ("claude"/"opencode") to an ABSOLUTE path. The host shells
// out to these agents (tmux `sh -c "claude …"` for the TUI, `execFile("opencode", …)`
// for session discovery/titling), both of which rely on the env PATH. But the host
// may be started with a minimal PATH (via `npx`, systemd, a GUI launcher, or another
// Claude Code session) that omits ~/.local/bin (claude) or ~/.opencode/bin (opencode),
// where these binaries actually live. When the agent isn't on that PATH the launch
// fails — the tmux pane shows `[exited]` (status 127), and opencode discovery silently
// returns nothing. Embedding the absolute path makes every invocation independent of
// how the host was started. Searches the current PATH first (an explicit install wins),
// then the common home bin dirs; falls back to the bare name so an agent on a PATH we
// don't enumerate still works exactly as before.
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveAgentBin(agent: "claude" | "opencode"): string {
  // Prefer the live $HOME env var over os.homedir(): on Linux they're identical
  // (homedir() returns $HOME when set), but a directly-read env var is honored under
  // test runners that set HOME at runtime, where the cached native homedir() is not.
  const home = process.env.HOME || homedir();
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const fallbacks = [join(home, ".local", "bin"), join(home, ".opencode", "bin"), join(home, "bin")];
  for (const dir of [...pathDirs, ...fallbacks]) {
    const candidate = join(dir, agent);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* not here / not executable — keep looking */
    }
  }
  return agent; // not found anywhere — let the shell resolve it (preserves old behaviour)
}
