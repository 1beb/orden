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
import { spawn as ptySpawn } from "node-pty";
import type { Host } from "@orden/host-api";
import { readTranscriptTitle } from "./transcriptTitle";
import { persistTitle, persistSummary } from "./sessionTitles";
import {
  discoverOpencodeSession,
  existingOpencodeSessions,
  readOpencodeTitle,
} from "./opencodeSession";

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

async function buildCommand(host: Host, rec: SessionRecord, sessionId: string): Promise<string> {
  if (rec.agent === "opencode") {
    // opencode's TUI has no --session-id to MINT a chosen id (only -s/--session to
    // RESUME an existing one), so we can't pre-persist an id the way Claude allows.
    // Reattach: resume the id we discovered after the first launch (the poller
    // persists conversationId — see applyTranscriptTitle). First open: launch bare;
    // the discovered id is captured shortly after.
    if (rec.conversationId) return `opencode --session ${rec.conversationId}`;
    // First open: launch the TUI, seeding the card's text as the initial prompt.
    let cmd = "opencode"; // interactive opencode TUI (id discovered post-launch)
    if (rec.initialPrompt) {
      cmd += ` --prompt ${shquote(rec.initialPrompt)}`;
      rec.initialPrompt = undefined;
      await host.vault.set("sessions", sessionId, rec);
    }
    return cmd;
  }
  // claude: resume the conversation if we have its id, else mint one and persist
  // it so chat-mode and future TUI opens continue the same session.
  if (rec.conversationId)
    return `claude ${mcpConfigArg(rec.conversationId)} --resume ${rec.conversationId}`;
  const id = randomUUID();
  rec.conversationId = id;
  // First open: pass the card's text as claude's positional prompt so the agent
  // starts working on it immediately. Cleared so a later --resume won't resend.
  // --mcp-config binds this session's claude to its scoped orden MCP endpoint.
  let cmd = `claude ${mcpConfigArg(id)} --session-id ${id}`;
  if (rec.initialPrompt) {
    cmd += ` ${shquote(rec.initialPrompt)}`;
    rec.initialPrompt = undefined;
  }
  await host.vault.set("sessions", sessionId, rec);
  return cmd;
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
    const cmd = await buildCommand(host, rec, sessionId);
    const tmuxName = tmuxNameFor(sessionId);
    // Mirror handle()'s tmux invocation, but detached (-d) and via plain spawn
    // (no pty needed to merely create). `cmd` is a single shell string and is
    // passed as the trailing positional arg, exactly as handle() does.
    await new Promise<void>((resolve) => {
      const child = spawn(
        "tmux",
        [
          "new-session", "-d", "-A", "-e", "ORDEN_MANAGED=1", "-s", tmuxName,
          "-c", defaultCwd, cmd,
          ";", "set-option", "-g", "mouse", "on",
          ";", "set-option", "-g", "window-size", "latest",
          ";", "set-option", "-g", "aggressive-resize", "on",
        ],
        {
          cwd: defaultCwd,
          env: { ...process.env, ORDEN_MANAGED: "1" } as Record<string, string>,
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

async function handle(
  host: Host,
  defaultCwd: string,
  socket: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const sessionId = url.searchParams.get("session");
  const cols = Math.max(20, Number(url.searchParams.get("cols")) || 80);
  const rows = Math.max(5, Number(url.searchParams.get("rows")) || 24);
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

  // For a first-open opencode session (no id yet) snapshot the session ids that
  // already exist in this cwd BEFORE launching, so post-launch discovery only picks
  // up the session opencode is about to create — not a pre-existing one.
  const preLaunch =
    rec.agent === "opencode" && !rec.conversationId
      ? await existingOpencodeSessions(defaultCwd)
      : new Set<string>();

  const cmd = await buildCommand(host, rec, sessionId);
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
      "-x", String(cols), "-y", String(rows), "-c", defaultCwd, cmd,
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
      cwd: defaultCwd,
      cols,
      rows,
      env: { ...process.env, ORDEN_MANAGED: "1" } as Record<string, string>,
    },
  );

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
        defaultCwd,
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

  let touched = false;
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!touched) {
        touched = true;
        void markTouched(host, sessionId); // a keystroke = the user used this session
      }
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
    if (titleTimer) {
      clearInterval(titleTimer);
      titleTimer = null;
    }
    try {
      term.kill(); // detaches the tmux client
    } catch {
      /* ignore */
    }
    // An untouched session was abandoned — kill its tmux so nothing lingers
    // (the web side deletes the session record in parallel).
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
