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

// Title a still-untitled session from Claude's OWN session title (the ai-title
// line it writes into its transcript — see transcriptTitle.ts). Also retitles
// the linked kanban card. Returns true once a title has been applied (so the
// poller can stop). claude-only: opencode has no such transcript.
async function applyTranscriptTitle(
  host: Host,
  sessionId: string,
  cwd: string,
  conversationId: string | undefined,
): Promise<boolean> {
  if (!conversationId) return false;
  const title = readTranscriptTitle(cwd, conversationId);
  if (!title) return false;
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

async function buildCommand(host: Host, rec: SessionRecord, sessionId: string): Promise<string> {
  if (rec.agent === "opencode") return "opencode"; // interactive opencode TUI
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

  // Poll for Claude's self-authored session title and apply it while the session
  // is still "Untitled". Claude writes the ai-title a few seconds into the
  // interactive session, and rewrites it as the conversation grows; we stop once
  // a title sticks. unref'd so it never holds the process open. claude-only.
  let titleTimer: ReturnType<typeof setInterval> | null = null;
  if (rec.agent === "claude") {
    titleTimer = setInterval(() => {
      void applyTranscriptTitle(host, sessionId, defaultCwd, rec.conversationId).then((done) => {
        if (done && titleTimer) {
          clearInterval(titleTimer);
          titleTimer = null;
        }
      });
    }, 5000);
    titleTimer.unref?.();
  }

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
