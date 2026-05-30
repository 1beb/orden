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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn as ptySpawn } from "node-pty";
import type { Host } from "@orden/host-api";
import { readTranscriptTitle } from "./transcriptTitle";
import {
  discoverOpencodeSession,
  existingOpencodeSessions,
  readOpencodeTitle,
} from "./opencodeSession";

const exec = promisify(execFile);

interface SessionRecord {
  id: string;
  title?: string;
  agent: "claude" | "opencode";
  conversationId?: string;
  touched?: boolean;
  projectId: string;
  [k: string]: unknown;
}

const UNTITLED = new Set(["", "Untitled", "Untitled session"]);

async function markTouched(host: Host, sessionId: string): Promise<void> {
  const rec = await host.vault.get<SessionRecord>("sessions", sessionId);
  if (rec && !rec.touched) {
    rec.touched = true;
    await host.vault.set("sessions", sessionId, rec);
  }
}

// Write a discovered title onto the session record (while still "Untitled") and
// the linked kanban card. Returns true once a title sticks (so the poller stops).
async function persistTitle(host: Host, sessionId: string, title: string): Promise<boolean> {
  const rec = await host.vault.get<SessionRecord>("sessions", sessionId);
  if (!rec) return true; // session gone — nothing more to do
  if (!UNTITLED.has((rec.title ?? "").trim())) return true; // user/agent already named it
  rec.title = title;
  await host.vault.set("sessions", sessionId, rec);
  const cardIds = await host.vault.list("cards");
  for (const cid of cardIds) {
    const card = await host.vault.get<{ sessionId?: string; [k: string]: unknown }>("cards", cid);
    if (card && card.sessionId === sessionId) {
      await host.vault.set("cards", cid, { ...card, title });
      break;
    }
  }
  return true;
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
    return "opencode"; // interactive opencode TUI (id discovered post-launch)
  }
  // claude: resume the conversation if we have its id, else mint one and persist
  // it so chat-mode and future TUI opens continue the same session.
  if (rec.conversationId) return `claude --resume ${rec.conversationId}`;
  const id = randomUUID();
  rec.conversationId = id;
  await host.vault.set("sessions", sessionId, rec);
  return `claude --session-id ${id}`;
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
  const tmuxName = `orden-${sessionId}`;
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
      "new-session", "-A", "-s", tmuxName,
      "-x", String(cols), "-y", String(rows), "-c", defaultCwd, cmd,
      ";", "set-option", "-g", "mouse", "on",
      ";", "set-option", "-g", "window-size", "latest",
      ";", "set-option", "-g", "aggressive-resize", "on",
    ],
    // ORDEN_MANAGED marks this as an orden-launched session: the project-local
    // Claude hooks only POST state updates when it's set, so the hooks stay inert
    // for the user's own Claude sessions in this repo.
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
