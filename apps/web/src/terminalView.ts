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

  // Mobile browsers emit no wheel events, so the desktop scroll path never runs
  // on a touch swipe. The host forces tmux `mouse on` (see host terminal.ts), so
  // scrolling an alternate-screen TUI goes: wheel event -> xterm encodes a mouse
  // wheel report -> tmux scrolls. We replay that exact path by synthesizing
  // WheelEvents on xterm's screen element. Each event is one cell-height notch
  // carrying the touch coordinates (xterm needs them to build the mouse report),
  // emitted once per cell of finger travel so the speed tracks the swipe.
  let touchY: number | null = null;
  let touchX = 0;
  let accum = 0;
  const screenEl = () =>
    container.querySelector<HTMLElement>(".xterm-screen") ?? container;
  const cellHeight = () => {
    const vp = container.querySelector<HTMLElement>(".xterm-viewport");
    return vp && term.rows > 0 ? vp.clientHeight / term.rows : 17;
  };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
    touchX = e.touches[0].clientX;
    accum = 0;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (touchY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    touchX = e.touches[0].clientX;
    accum += touchY - y; // finger up (positive) => scroll content down
    touchY = y;
    const h = cellHeight();
    const notches = Math.trunc(accum / h);
    if (notches === 0) return;
    accum -= notches * h;
    const screen = screenEl();
    const dir = notches > 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(notches); i++) {
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: dir * h,
          deltaMode: 0, // pixels, same as a real trackpad
          clientX: touchX,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    e.preventDefault();
  };
  const onTouchEnd = () => {
    touchY = null;
    accum = 0;
  };
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });

  return () => {
    try {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
    } catch {
      /* ignore */
    }
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
