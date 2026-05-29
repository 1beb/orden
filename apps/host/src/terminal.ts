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
import { spawn as ptySpawn } from "node-pty";
import type { Host } from "@orden/host-api";

interface SessionRecord {
  id: string;
  agent: "claude" | "opencode";
  conversationId?: string;
  projectId: string;
  [k: string]: unknown;
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
    // attach-or-create: the command only runs when the session is first created
    ["new-session", "-A", "-s", tmuxName, "-x", String(cols), "-y", String(rows), "-c", defaultCwd, cmd],
    { name: "xterm-256color", cwd: defaultCwd, cols, rows, env: process.env as Record<string, string> },
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

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
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
      term.kill(); // detaches tmux; the agent session persists
    } catch {
      /* ignore */
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
