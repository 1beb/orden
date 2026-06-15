// Destructive-git guardrail (worktree isolation design) — SINGLE source of truth.
// Worktrees protect sessions from each other; this protects the SHARED checkout
// (isolation off, non-git dir) from the commands that wipe uncommitted state.
// String matching is a layered guardrail, not a sandbox — trivially bypassable
// via sh -c, aliases, or scripts; the structural protection is the worktree.
// `git stash` is included because in a shared checkout it sweeps up OTHER
// sessions' (and the user's) dirty state, not just the caller's own.
//
// TWO consumers enforce these patterns and must never drift apart again (they
// once did — the opencode copy let `git stash list && git stash` through):
//   - the claude PreToolUse hook (hooks.ts -> preToolUseVerdict)
//   - the generated opencode plugin (opencodePlugin.ts), which embeds the
//     patterns by serializing them via `destructiveGitArrayLiteral` below
// destructiveGit.test.ts runs one command corpus against BOTH consumers.
export const DESTRUCTIVE_GIT: readonly RegExp[] = [
  /\bgit\s+(?:\S+\s+)*reset\s+(?:\S+\s+)*--hard\b/,
  /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$|;|&|\|)/,
  /\bgit\s+clean\s+-\w*[fdx]/,
  // Per-position negative lookahead, NOT a whole-string safe-list negation: the
  // latter is defeated by any innocent safe subcommand elsewhere in a compound
  // command (`git stash list && git stash`).
  /\bgit\s+stash\b(?!\s+(?:list|show|pop|apply|branch|drop))/,
];

export function isDestructiveGit(command: string): boolean {
  return DESTRUCTIVE_GIT.some((re) => re.test(command));
}

// The user-facing denial, shared verbatim by both consumers.
export const DESTRUCTIVE_GIT_DENY_REASON =
  "orden: destructive git is blocked in a SHARED checkout (it can wipe other sessions' and the user's uncommitted work). Commit instead, or ask the user.";

// The patterns as a JS array-literal expression, for embedding in GENERATED
// code (the opencode plugin source). JSON.stringify-ing `re.source` handles all
// escaping, so the generated regexes are character-identical to the ones above.
export function destructiveGitArrayLiteral(): string {
  return `[${DESTRUCTIVE_GIT.map((re) => `new RegExp(${JSON.stringify(re.source)})`).join(", ")}]`;
}
