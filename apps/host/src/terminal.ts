// Terminal bus: streams a real agent TUI to the browser. Each /term WebSocket
// attaches a pty (node-pty) to a per-session tmux session running claude/opencode.
// tmux gives persistence — closing the socket just detaches; the agent keeps
// running and reattaches on reconnect. Server-only (native node-pty + tmux).
//
// Wire protocol (one socket per terminal):
//   server → client : pty output (text frames)
//   client → server : keystrokes (binary frames) | {"resize":[cols,rows]} (text)

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn as ptySpawn } from "node-pty";
import type { Host, Project } from "@orden/host-api";
import { readTranscriptTitle, claudeTranscriptExists } from "./transcriptTitle";
// Resolve agent CLIs to absolute paths so a minimal host PATH can't break launch
// (see agentBin.ts). Re-exported so tests can drive it via this module's surface.
import { resolveAgentBin } from "./agentBin";
export { resolveAgentBin };
import { persistTitle, persistSummary } from "./sessionTitles";
import {
  discoverOpencodeSession,
  existingOpencodeSessions,
  readOpencodeTitle,
} from "./opencodeSession";
import {
  readWorktreeSettings,
  isolationEnabled,
  ensureSessionWorktree,
  type GitExec,
} from "./worktrees";

const exec = promisify(execFile);

// The tmux session name a given orden session's agent runs under. One place so
// launch, reattach, and kill all agree on the convention.
export function tmuxNameFor(sessionId: string): string {
  return `orden-${sessionId}`;
}

// Permanently stop a session's agent by killing its tmux session. Idempotent:
// a missing session just makes tmux exit non-zero, which we swallow.
export async function killSessionTmux(sessionId: string): Promise<void> {
  await exec("tmux", ["kill-session", "-t", tmuxNameFor(sessionId)]).catch(() => {});
}

// Build the env vars (tmux -e arguments + spawn env entries) for opencode
// sessions that carry the kanban state plugin.
function opencodeEnv(
  rec: { agent: "claude" | "opencode" },
  sessionId: string,
): { args: string[]; env: Record<string, string>; cmdPrefix: string } {
  if (rec.agent !== "opencode") return { args: [], env: {}, cmdPrefix: "" };
  const pluginDir = ensureOpencodePluginDir(sessionId);
  const port = process.env.ORDEN_PORT ?? 4319;
  // Set env vars BOTH in the tmux session environment AND directly on the
  // command line. Shell init files (.bashrc, .zshrc) can clear inherited env,
  // but inline VAR=val cmd assignments survive regardless — so the plugin
  // always has ORDEN_SESSION_ID and can post back with a truthy value.
  const cmdPrefix = `ORDEN_SESSION_ID=${shquote(sessionId)} OPENCODE_CONFIG_DIR=${shquote(pluginDir)} ORDEN_PORT=${shquote(String(port))}`;
  return {
    args: [
      "-e", `ORDEN_SESSION_ID=${sessionId}`,
      "-e", `OPENCODE_CONFIG_DIR=${pluginDir}`,
      "-e", `ORDEN_PORT=${port}`,
    ],
    env: {
      ORDEN_SESSION_ID: sessionId,
      OPENCODE_CONFIG_DIR: pluginDir,
      ORDEN_PORT: String(port),
    },
    cmdPrefix,
  };
}

interface SessionRecord {
  id: string;
  title?: string;
  summary?: string;
  agent: "claude" | "opencode";
  conversationId?: string;
  touched?: boolean;
  projectId: string;
  // Text to hand the agent on FIRST launch (the card's title when a session is
  // started from a card). Consumed + cleared by buildCommand so a later reattach
  // doesn't re-send it.
  initialPrompt?: string;
  // Worktree isolation (HOST_OWNED, like conversationId): the per-session git
  // worktree the agent runs in, and the orden/<slug> branch it was created on.
  // Set by resolveSessionCwd on first launch; reused on resume.
  workdir?: string;
  branch?: string;
  [k: string]: unknown;
}

// Single-quote a string for /bin/sh — tmux runs the launch command through the
// shell, so the prompt must survive spaces, quotes, and metacharacters intact.
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}


// Build the `--mcp-config <json>` fragment that binds a launched claude session
// to ITS OWN scoped orden MCP endpoint: http://127.0.0.1:<port>/mcp/<convId>.
// The server reads the conversationId from the path, so every tool call from
// this agent is bound to this session. Quoted with shquote so the inline JSON
// survives the shell tmux runs the launch command through.
export function mcpConfigArg(convId: string): string {
  const port = Number(process.env.ORDEN_PORT ?? 4319);
  const config = {
    mcpServers: { orden: { type: "http", url: `http://127.0.0.1:${port}/mcp/${convId}` } },
  };
  return `--mcp-config ${shquote(JSON.stringify(config))}`;
}

// Build the `--settings '<json>'` fragment that injects this session's kanban
// state hooks at launch — so an orden-managed claude carries the automatic
// working/waiting cycle WITHOUT depending on an ambient project
// `.claude/settings.json`. Mirrors mcpConfigArg: orden owns the wiring and
// templates the live port (the old ambient file hardcoded 4319). The receiving
// contract is apps/host/src/hooks.ts:
//   UserPromptSubmit / PostToolUse -> in-progress  (Claude is working; PostToolUse
//     is the recovery edge that un-blocks a card after a mid-turn permission or
//     AskUserQuestion pause, which is otherwise never followed by a prompt submit)
//   Stop                           -> blocked      (turn over, awaiting you —
//     but the host GATES this on in-flight subagents: a Stop while a background
//     subagent workflow is still running is a turn-end, not a wait, so the card
//     stays in-progress)
//   SubagentStart / SubagentStop   -> /session-subagent (count in-flight
//     subagents per session; both carry the parent session_id)
//   Notification                   -> /notification (the host blocks only the
//     waiting types: permission / idle / elicitation)
// No ORDEN_MANAGED gate is needed here: unlike the ambient file (which applied to
// EVERY claude launched in the repo, including the user's own, hence the gate),
// these settings reach ONLY the process orden launches.
export function settingsArg(sessionId: string): string {
  const port = Number(process.env.ORDEN_PORT ?? 4319);
  // Bake the STABLE orden session id into every hook URL. Claude's hook payload
  // carries only its OWN session_id (which equals the conversationId); passing
  // the orden session id alongside it lets the host repair a record whose
  // conversationId was lost or went stale (see reconcileConversationId in
  // hooks.ts) — so the hook->card mapping, the MCP binding, and a later --resume
  // can never be silently severed from the conversation again. sessionId is the
  // vault key (alnum + underscore), so it needs no URL-encoding.
  const post = (path: string): string => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://127.0.0.1:${port}/hooks/${path}${sep}orden_session_id=${sessionId}`;
    return (
      `curl -sS -m 3 -X POST '${url}' ` +
      `-H 'Content-Type: application/json' -d @- >/dev/null 2>&1 || true`
    );
  };
  const hook = (command: string) => [{ hooks: [{ type: "command", command }] }];
  // The destructive-git guardrail differs from the state hooks: it must RETURN
  // the host's JSON verdict to claude (PreToolUse decision protocol), so its
  // curl keeps stdout. Matched to Bash only — other tools can't run git.
  const guardUrl = `http://127.0.0.1:${port}/hooks/pretooluse?orden_session_id=${sessionId}`;
  const guard =
    `curl -sS -m 3 -X POST '${guardUrl}' ` +
    `-H 'Content-Type: application/json' -d @- 2>/dev/null || true`;
  const settings = {
    hooks: {
      UserPromptSubmit: hook(post("session-state?state=in-progress")),
      PostToolUse: hook(post("session-state?state=in-progress")),
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }],
      Stop: hook(post("session-state?state=blocked")),
      // Count in-flight subagents so a background "subagent workflow" turn-end
      // (Stop) doesn't park the card at blocked while subagents keep working.
      SubagentStart: hook(post("session-subagent?delta=start")),
      SubagentStop: hook(post("session-subagent?delta=stop")),
      Notification: hook(post("notification")),
    },
  };
  return `--settings ${shquote(JSON.stringify(settings))}`;
}

// opencode kanban state plugin: mirrors what settingsArg() does for Claude hooks.
// Opencode doesn't have inline --settings, so we generate a tiny plugin file and
// point opencode at it via OPENCODE_CONFIG_DIR. The plugin uses fetch() (Bun's
// in-process HTTP) to POST state transitions to the host. Sessions are mapped via
// ORDEN_SESSION_ID (not conversationId) so the host doesn't need the opencode
// session id to be pre-registered — the first event (session.created) carries the
// opencode id and the host persists it then.
//
// Event mapping:
//   session.created / session.updated / tool.execute.after -> in-progress
//   session.idle                                          -> blocked
//
// Subagent gating (Claude's SubagentStart/Stop) is not wired for opencode yet;
// session.idle fires even while child sessions run, which may cause premature
// blocked transitions during subagent workflows.
function opencodePluginSource(): string {
  return `// auto-generated orden kanban plugin — do not edit
export const OrdenKanban = async () => {
  const PORT = process.env.ORDEN_PORT || "4319"
  const ORDEN_SID = process.env.ORDEN_SESSION_ID || ""

  const post = async (path, extra) => {
    try {
      await fetch("http://127.0.0.1:" + PORT + "/hooks/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...extra, orden_session_id: ORDEN_SID }),
      })
    } catch (e) {
      console.error("[orden-kanban] hook post failed:", String(e))
    }
  }

  return {
    event: async ({ event }) => {
      if (!event?.type) return
      if (event.type === "session.created") {
        await post("session-state?state=in-progress", { session_id: event.properties?.id })
      }
      if (event.type === "session.idle") {
        await post("session-state?state=blocked")
      }
      if (event.type === "session.updated") {
        await post("session-state?state=in-progress")
      }
    },
    "tool.execute.after": async () => {
      await post("session-state?state=in-progress")
    },
  }
}
`;
}

// Create the plugin directory for an opencode session. Returns the path that
// should be set as OPENCODE_CONFIG_DIR. Idempotent — reattach reuses the same
// directory so the plugin file is only written once per session id.
function ensureOpencodePluginDir(sessionId: string): string {
  const dir = `${homedir()}/.orden/opencode-plugins/${sessionId}`;
  const pluginsDir = `${dir}/plugins`;
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ type: "module" }), "utf8");
  writeFileSync(`${pluginsDir}/orden-kanban.js`, opencodePluginSource(), "utf8");
  return dir;
}

// Resolve the working directory a session's agent should launch in. A `local`
// project runs in its OWN path; every other source kind (ephemeral has no
// folder; ssh/s3 are remote, not a local dir yet) falls back to the host's
// defaultCwd. A configured-but-missing local path also falls back rather than
// failing the tmux `-c` launch. Used by both launch paths (launchDetached +
// handle) so a session, its opencode session discovery, and its title polling
// all agree on one cwd.
//
// Worktree isolation: when the global setting (project-overridable) is on and
// the project path is a git repo, the session gets its OWN worktree on an
// orden/<slug> branch so no session can clobber a sibling's — or the user's —
// uncommitted state. The worktree is created lazily, but ONLY by the launch
// paths (opts.launch): read-only consumers (idle reconciler, transcript
// mirroring) just follow the persisted `workdir` and must never mint worktrees
// for sessions that were never launched. The chosen workdir/branch are
// persisted on the session record (HOST_OWNED).
//
// The rec param is structural (not the full SessionRecord) so read-side callers
// with their own narrower session types can pass theirs.
export interface SessionCwdRec {
  projectId?: string;
  workdir?: string;
  branch?: string;
  title?: string;
  initialPrompt?: string;
}

export async function resolveSessionCwd(
  host: Host,
  rec: SessionCwdRec,
  sessionId: string,
  defaultCwd: string,
  opts?: { launch?: boolean; exec?: GitExec },
): Promise<string> {
  // A session that already ran in a worktree stays associated with it — even
  // for reads after the worktree was reaped (claude keys transcripts by the
  // cwd the agent RAN in, so consistency beats existence here).
  if (!opts?.launch && typeof rec.workdir === "string" && rec.workdir) return rec.workdir;

  const projectId = rec.projectId;
  if (!projectId) return defaultCwd;
  const project = await host.vault.get<Project>("projects", projectId);
  if (!project || project.source.kind !== "local") return defaultCwd;
  const path = project.source.path;
  let dirOk = false;
  try {
    dirOk = existsSync(path) && statSync(path).isDirectory();
  } catch {
    /* fall through to the warn + default */
  }
  if (!dirOk) {
    // eslint-disable-next-line no-console
    console.warn(`orden: project ${projectId} local path is not a directory, using ${defaultCwd}: ${path}`);
    return defaultCwd;
  }
  if (!opts?.launch) return path;

  const settings = await readWorktreeSettings(host.vault);
  if (!isolationEnabled(settings.isolation, project)) return path;
  const vaultRoot = host.capabilities().vaultRoot;
  if (!vaultRoot) return path; // no persistent vault → nowhere to root worktrees
  const wt = await ensureSessionWorktree(
    {
      repo: path,
      vaultRoot,
      projectId: project.id,
      sessionId,
      title: rec.title && rec.title !== "Untitled session" ? rec.title : rec.initialPrompt,
      existingWorkdir: typeof rec.workdir === "string" ? rec.workdir : undefined,
      baseRefSetting: settings.baseRef,
    },
    opts?.exec,
  );
  if (!wt) return path; // non-git dir or creation failed: shared checkout
  if (rec.workdir !== wt.workdir) {
    rec.workdir = wt.workdir;
    if (wt.branch) rec.branch = wt.branch;
    await host.vault.set("sessions", sessionId, rec);
  }
  return wt.workdir;
}

async function markTouched(host: Host, sessionId: string): Promise<void> {
  const rec = await host.vault.get<SessionRecord>("sessions", sessionId);
  if (rec && !rec.touched) {
    rec.touched = true;
    await host.vault.set("sessions", sessionId, rec);
  }
}

// Title a still-untitled session from the AGENT's OWN session title, retitling the
// linked kanban card too. Returns true once a title has been applied (poller stops).
//
//   claude   — the ai-title line in its transcript (see transcriptTitle.ts).
//   opencode — the title in its session store, read via the CLI (opencodeSession.ts).
//              opencode can't be launched with a caller-chosen id, so on the FIRST
//              poll for an opencode session without a conversationId we DISCOVER the
//              id opencode minted (newest session in cwd not in `preLaunch`) and
//              persist it — that same id is what buildCommand resumes with `-s`.
async function applyTranscriptTitle(
  host: Host,
  sessionId: string,
  cwd: string,
  agent: "claude" | "opencode",
  conversationId: string | undefined,
  preLaunch: ReadonlySet<string>,
): Promise<boolean> {
  if (agent === "opencode") {
    let convId = conversationId;
    if (!convId) {
      const discovered = await discoverOpencodeSession(cwd, preLaunch);
      if (!discovered) return false; // opencode hasn't created its session yet
      const rec = await host.vault.get<SessionRecord>("sessions", sessionId);
      if (!rec) return true;
      rec.conversationId = discovered;
      await host.vault.set("sessions", sessionId, rec);
      convId = discovered;
    }
    const title = await readOpencodeTitle(cwd, convId);
    if (!title) return false; // still placeholder/untitled — keep polling
    return persistTitle(host, sessionId, title);
  }
  if (!conversationId) return false;
  const title = readTranscriptTitle(cwd, conversationId);
  if (!title) return false;
  // Once the transcript has a title it also has enough content for a digest;
  // capture it alongside (independent of whether the title actually sticks).
  await persistSummary(host, sessionId, cwd, conversationId);
  return persistTitle(host, sessionId, title);
}

export async function buildCommand(
  host: Host,
  rec: SessionRecord,
  sessionId: string,
  cwd: string,
  envPrefix?: string,
): Promise<string> {
  // Launch via the agent's absolute path so a minimal host PATH can't break it
  // (see resolveAgentBin). shquoted in case the resolved path contains spaces.
  const bin = shquote(resolveAgentBin(rec.agent));
  if (rec.agent === "opencode") {
    // opencode's TUI has no --session-id to MINT a chosen id (only -s/--session to
    // RESUME an existing one), so we can't pre-persist an id the way Claude allows.
    // Reattach: resume the id we discovered after the first launch (conversationId
    // is persisted either by the kanban plugin's first event or by the poller).
    // First open: launch bare; the id is captured shortly after.
    //
    // Kanban state hooks are wired via a generated opencode plugin (see
    // opencodePluginSource / ensureOpencodePluginDir above), pointed at via
    // OPENCODE_CONFIG_DIR in the tmux env. The plugin uses fetch() to POST
    // state transitions to /hooks/session-state, mapping through ORDEN_SESSION_ID
    // so the host doesn't need the opencode session id pre-registered.
    if (rec.conversationId) return `${bin} --session ${rec.conversationId}`;
    // First open: launch the TUI, seeding the card's text as the initial prompt.
    // envPrefix carries inline VAR=val assignments so the plugin's env vars survive
    // even if the shell init files clear inherited environment (see opencodeEnv).
    let cmd = envPrefix ? `${envPrefix} ${bin}` : bin;
    if (rec.initialPrompt) {
      cmd += ` --prompt ${shquote(rec.initialPrompt)}`;
      rec.initialPrompt = undefined;
      await host.vault.set("sessions", sessionId, rec);
    }
    return cmd;
  }
  // claude: resume the conversation if we have its id AND claude actually wrote
  // its transcript to disk. The id is persisted at MINT time (below) because the
  // scoped --mcp-config endpoint and --settings hooks bind to it before the agent
  // runs — but claude writes the transcript only once the session does real work.
  // A session opened and closed before its first turn (e.g. reaped as untouched)
  // leaves conversationId pointing at a file that never existed; `--resume` on it
  // errors "No conversation found" and exits instantly, so the tmux client just
  // prints `[exited]`. Guard on the transcript: resume only when it exists, else
  // fall through and relaunch with the SAME id (keeps the MCP binding stable).
  // --mcp-config binds this session to its scoped orden endpoint; --settings
  // injects the kanban state hooks (both port-templated by orden, no repo files).
  //
  // The id normally lives on the record (conversationId). But that field has been
  // seen to get lost by a record write that dropped it — which silently turned a
  // resume into a brand-new session and orphaned a real, multi-turn transcript. So
  // we also keep a host-owned recovery index (ns "convindex", key = orden session
  // id) that the web never writes, and fall back to it when the record's id is
  // gone. (The hook self-heal in hooks.ts repairs the record going forward; this
  // index covers a resume that happens before any hook has had the chance to.)
  let convId = rec.conversationId;
  if (!convId) {
    const idx = await host.vault.get<{ conversationId?: string }>("convindex", sessionId);
    if (idx?.conversationId) convId = idx.conversationId; // recovered after a record clobber
  }
  if (convId && claudeTranscriptExists(cwd, convId)) {
    // Heal the record if it had lost (or never carried) the recovered id, so the
    // conversationId-keyed lookups and the next reattach work off it again.
    if (rec.conversationId !== convId) {
      rec.conversationId = convId;
      await host.vault.set("sessions", sessionId, rec);
    }
    await host.vault.set("convindex", sessionId, { conversationId: convId });
    return `${bin} ${mcpConfigArg(convId)} ${settingsArg(sessionId)} --resume ${convId}`;
  }
  // No resumable conversation. Don't silently fake a resume: if the session has
  // ALREADY done work, minting a brand-new conversation orphans its history, so
  // surface it rather than hiding it. A genuinely-new session (no prior activity)
  // is the normal first-launch path and stays quiet.
  if (!convId && hasPriorActivity(rec)) {
    // eslint-disable-next-line no-console
    console.warn(
      `orden: session ${sessionId} shows prior activity but has no recoverable conversation id — ` +
        `starting a NEW conversation (any previous history is orphaned)`,
    );
  }
  // Keep an existing-but-unresumable id (e.g. a transcript under a different cwd)
  // so the scoped MCP endpoint stays bound; only mint for a truly-new session.
  const id = convId ?? randomUUID();
  rec.conversationId = id;
  // First open: pass the card's text as claude's positional prompt so the agent
  // starts working on it immediately. Cleared so a later --resume won't resend.
  let cmd = `${bin} ${mcpConfigArg(id)} ${settingsArg(sessionId)} --session-id ${id}`;
  if (rec.initialPrompt) {
    cmd += ` ${shquote(rec.initialPrompt)}`;
    rec.initialPrompt = undefined;
  }
  await host.vault.set("sessions", sessionId, rec);
  await host.vault.set("convindex", sessionId, { conversationId: id });
  return cmd;
}

// Has this session already done real work? A session that has been interacted
// with (touched), found to carry a real human turn (prompted), or self-titled by
// the agent has a conversation worth preserving — so starting a fresh one for it
// is a data-loss signal, not a normal first launch.
function hasPriorActivity(rec: SessionRecord): boolean {
  if (rec.touched || rec.prompted) return true;
  const title = (rec.title ?? "").trim();
  return title !== "" && title !== "Untitled" && title !== "Untitled session";
}

// Launch-on-create: spawn a DETACHED tmux session running the agent, with no
// client attached. Used by the host's pendingLaunch reactor so a session created
// via the MCP tool starts working immediately, before any browser opens its panel.
//
// buildCommand here mints+persists the conversationId and the bound --mcp-config,
// then clears initialPrompt — exactly what a later attach needs. When the user
// opens the panel, handle()'s `new-session -A` ATTACHES to this same tmux session;
// and because conversationId is now persisted, buildCommand returns `--resume`,
// so there is no double-mint.
//
// Idempotent: tmux `new-session -d -A` is attach-or-create detached, so if the
// session already exists this is a no-op. Never throws — a failed launch must
// not crash the host.
export async function launchDetached(
  host: Host,
  defaultCwd: string,
  sessionId: string,
): Promise<void> {
  try {
    const rec = await host.vault.get<SessionRecord>("sessions", sessionId);
    if (!rec) return;
    const cwd = await resolveSessionCwd(host, rec, sessionId, defaultCwd, { launch: true });
    const ocEnv = opencodeEnv(rec, sessionId);
    const cmd = await buildCommand(host, rec, sessionId, cwd, ocEnv.cmdPrefix);
    const tmuxName = tmuxNameFor(sessionId);
    // (no pty needed to merely create). `cmd` is a single shell string and is
    // passed as the trailing positional arg, exactly as handle() does.
    await new Promise<void>((resolve) => {
      const child = spawn(
        "tmux",
        [
          "new-session", "-d", "-A", "-e", "ORDEN_MANAGED=1", "-s", tmuxName,
          "-c", cwd,
          ...ocEnv.args,
          cmd,
          ";", "set-option", "-g", "mouse", "on",
          ";", "set-option", "-g", "window-size", "latest",
          ";", "set-option", "-g", "aggressive-resize", "on",
        ],
        {
          cwd,
          env: { ...process.env, ORDEN_MANAGED: "1", ...ocEnv.env } as Record<string, string>,
          stdio: "ignore",
          detached: true,
        },
      );
      child.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.warn(`orden: launchDetached spawn failed for ${sessionId}:`, err);
        resolve();
      });
      child.on("exit", () => resolve());
      child.unref();
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`orden: launchDetached failed for ${sessionId}:`, err);
  }
}

// A scratch terminal is a plain reattachable shell, not bound to any session
// record: the URL asks for it via `scratch=1` or the reserved `session=scratch`.
export function isScratchReq(url: URL): boolean {
  return url.searchParams.get("scratch") === "1" || url.searchParams.get("session") === "scratch";
}

// The universal pty <-> socket wiring shared by every /term branch (agent and
// scratch): pty output -> socket, pty exit -> close socket, socket keystrokes
// (binary) -> pty, socket {"resize":[c,r]} (text) -> pty.resize, socket close ->
// kill the pty (which only DETACHES the tmux client; the tmux session persists).
// `onKeystroke` lets the agent path observe first-keystroke "touched" without
// reimplementing the message loop. Returns nothing; both paths add their own
// extra close handlers (title-timer cleanup, untouched-kill) on top.
function pipePtyToSocket(
  term: ReturnType<typeof ptySpawn>,
  socket: WebSocket,
  onKeystroke?: () => void,
): void {
  term.onData((d) => {
    if (socket.readyState === socket.OPEN) socket.send(d);
  });
  term.onExit(() => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      onKeystroke?.();
      term.write(data.toString("utf8")); // keystrokes
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (Array.isArray(msg.resize)) term.resize(Math.max(20, msg.resize[0]), Math.max(5, msg.resize[1]));
    } catch {
      /* ignore non-JSON control frames */
    }
  });
  socket.on("close", () => {
    try {
      term.kill(); // detaches the tmux client
    } catch {
      /* ignore */
    }
  });
}

async function handle(
  host: Host,
  defaultCwd: string,
  socket: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const cols = Math.max(20, Number(url.searchParams.get("cols")) || 80);
  const rows = Math.max(5, Number(url.searchParams.get("rows")) || 24);

  // Scratch terminal: a single shared, reattachable plain login shell under the
  // fixed tmux session `orden-scratch`. No Session record, no vault entry, no
  // kanban card — `new-session -A` attaches-or-creates so reconnects share one
  // shell and no orphans accumulate.
  if (isScratchReq(url)) {
    const shell = process.env.SHELL || "/bin/bash";
    const term = ptySpawn(
      "tmux",
      [
        "new-session", "-A", "-s", "orden-scratch",
        "-x", String(cols), "-y", String(rows), "-c", defaultCwd,
        shell,
        ";", "set-option", "-g", "mouse", "on",
        ";", "set-option", "-g", "window-size", "latest",
        ";", "set-option", "-g", "aggressive-resize", "on",
      ],
      {
        name: "xterm-256color",
        cwd: defaultCwd,
        cols,
        rows,
        env: process.env as Record<string, string>,
      },
    );
    pipePtyToSocket(term, socket);
    return;
  }

  const sessionId = url.searchParams.get("session");
  if (!sessionId) {
    socket.close();
    return;
  }
  const rec = await host.vault.get<SessionRecord>("sessions", sessionId);
  if (!rec) {
    socket.send("orden: session not found\r\n");
    socket.close();
    return;
  }

  // Launch in the session's project directory or its isolated worktree (falls
  // back to defaultCwd). Used for the tmux launch AND for opencode discovery /
  // title polling below — they must all read the same cwd the agent actually
  // runs in.
  const cwd = await resolveSessionCwd(host, rec, sessionId, defaultCwd, { launch: true });

  // For a first-open opencode session (no id yet) snapshot the session ids that
  // already exist in this cwd BEFORE launching, so post-launch discovery only picks
  // up the session opencode is about to create — not a pre-existing one.
  const preLaunch =
    rec.agent === "opencode" && !rec.conversationId
      ? await existingOpencodeSessions(cwd)
      : new Set<string>();

  const ocEnv = opencodeEnv(rec, sessionId);
  const cmd = await buildCommand(host, rec, sessionId, cwd, ocEnv.cmdPrefix);
  const tmuxName = tmuxNameFor(sessionId);
  const term = ptySpawn(
    "tmux",
    // attach-or-create: the command only runs when the session is first created.
    // The chained tmux options (";" is a literal arg tmux reads as a command
    // separator; all idempotent on re-attach) make mobile usable:
    //   - mouse on: touch-drag / wheel scrolls the TUI history (the agent's
    //     alternate-screen has no xterm scrollback to swipe otherwise).
    //   - window-size latest + aggressive-resize: the window follows the CURRENT
    //     client's size, so reattaching from a wider device uses the full width
    //     for live output (tmux can't reflow already-captured scrollback lines).
    [
      // -e sets ORDEN_MANAGED in the SESSION environment so the pane (shell +
      // agent) inherits it. Setting it only on this spawn's env (below) is not
      // enough: `new-session -A` runs the command inside the tmux SERVER, which
      // — when a server is already running from an earlier session — keeps its
      // own env and drops the client's. -e is applied per new session, so it
      // survives a shared server. Without it the Claude hooks see no
      // ORDEN_MANAGED and never POST state, so the kanban card never moves.
      "new-session", "-A", "-e", "ORDEN_MANAGED=1", "-s", tmuxName,
      "-x", String(cols), "-y", String(rows), "-c", cwd,
      ...ocEnv.args,
      cmd,
      ";", "set-option", "-g", "mouse", "on",
      ";", "set-option", "-g", "window-size", "latest",
      ";", "set-option", "-g", "aggressive-resize", "on",
    ],
    // ORDEN_MANAGED marks this as an orden-launched session: the project-local
    // Claude hooks only POST state updates when it's set, so the hooks stay inert
    // for the user's own Claude sessions in this repo. (Belt-and-suspenders for the
    // case where this spawn starts the tmux server fresh; -e above is the real fix.)
    {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env: { ...process.env, ORDEN_MANAGED: "1", ...ocEnv.env } as Record<string, string>,
    },
  );

  // Universal pty <-> socket wiring (output, exit, keystrokes, resize, close ->
  // detach). The agent path layers session-specific concerns on top: a
  // first-keystroke "touched" mark, and title-timer cleanup + untouched-kill in
  // its own close handler below.
  let touched = false;
  pipePtyToSocket(term, socket, () => {
    if (!touched) {
      touched = true;
      void markTouched(host, sessionId); // a keystroke = the user used this session
    }
  });

  // Poll for the agent's self-authored session title and apply it while the session
  // is still "Untitled". Both agents write a title a few seconds into the session
  // and rewrite it as the conversation grows; we stop once a title sticks. For
  // opencode this poll also DISCOVERS+persists the session id (conversationId) the
  // first time round so reattach can resume it. unref'd so it never holds the
  // process open. The persisted conversationId is read back from the record each
  // tick (the closure-captured rec.conversationId may be stale once discovered).
  let titleTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void (async () => {
      const fresh = await host.vault.get<SessionRecord>("sessions", sessionId);
      const convId = fresh?.conversationId ?? rec.conversationId;
      const done = await applyTranscriptTitle(
        host,
        sessionId,
        cwd,
        rec.agent,
        convId,
        preLaunch,
      );
      if (done && titleTimer) {
        clearInterval(titleTimer);
        titleTimer = null;
      }
    })();
  }, 5000);
  titleTimer.unref?.();

  // Session-specific close handling, layered on top of pipePtyToSocket's own
  // close handler (which kills/detaches the pty): stop the title poller, and if
  // the session was never touched, kill its tmux so nothing lingers (the web
  // side deletes the session record in parallel).
  socket.on("close", () => {
    if (titleTimer) {
      clearInterval(titleTimer);
      titleTimer = null;
    }
    if (!touched) {
      void exec("tmux", ["kill-session", "-t", tmuxName]).catch(() => {});
    }
  });
}

export function createTerminalWss(host: Host, defaultCwd: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    void handle(host, defaultCwd, socket, req);
  });
  return wss;
}
