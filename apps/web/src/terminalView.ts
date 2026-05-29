// Renders a live agent TUI with xterm.js, attached to the host's /term pty over
// a dedicated WebSocket. Keystrokes go up as binary; pty output comes back as
// text; resize is a JSON control frame. Returns a dispose fn.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function mountTerminal(container: HTMLElement, sessionId: string): () => void {
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: true,
    // light theme to match the app (no black background)
    theme: {
      background: "#fbfbfa",
      foreground: "#1f2328",
      cursor: "#6d28d9",
      selectionBackground: "#ede9fe",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  try {
    fit.fit();
  } catch {
    /* container not laid out yet */
  }

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}/term?session=${encodeURIComponent(sessionId)}&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (e) => {
    if (typeof e.data === "string") term.write(e.data);
    else term.write(new Uint8Array(e.data as ArrayBuffer));
  };
  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
  });

  const sendResize = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
    }
  };
  term.onResize(sendResize);
  ws.onopen = () => {
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    sendResize();
    term.focus();
  };

  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
  });
  ro.observe(container);

  return () => {
    try {
      ro.disconnect();
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      term.dispose();
    } catch {
      /* ignore */
    }
  };
}
