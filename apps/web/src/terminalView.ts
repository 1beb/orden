// Renders a live agent TUI with xterm.js, attached to the host's /term pty over
// a dedicated WebSocket. Keystrokes go up as binary; pty output comes back as
// text; resize is a JSON control frame. Returns a dispose fn.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function mountTerminal(
  container: HTMLElement,
  sessionId: string,
  onInput?: () => void,
): () => void {
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
  let signalledInput = false;
  term.onData((d) => {
    // First keystroke = the user is using this session. Signal synchronously so
    // the reap predicate (isAbandoned) sees it before a fast navigate-away.
    if (!signalledInput) {
      signalledInput = true;
      onInput?.();
    }
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
  // WheelEvents on xterm's screen element, one discrete LINE-mode notch per cell
  // of finger travel (carrying the touch coordinates xterm needs for the report).
  //
  // Two mobile-specific hazards this dodges:
  //  - deltaMode=LINE, deltaY=±1 (NOT pixels): xterm's CoreMouseService dampens
  //    pixel-mode deltas under 50px by 0.3 to tame trackpad spam (xterm #3848),
  //    then gates the mouse report on the floored row count. A per-cell pixel
  //    notch (~17px) is always dampened to ~0.3 rows and floors to 0, so ~70% of
  //    our events sent NO report — scrolling crawled. LINE mode skips that branch
  //    entirely: r = deltaY, so every notch reliably emits exactly one report.
  //  - touch-action/overscroll: the alt-screen viewport has no scrollback to
  //    consume the swipe, so without touch-action Firefox (and others) hand the
  //    gesture to pull-to-refresh / document overscroll before tmux sees it. We
  //    claim it on the container (restored on dispose, since the element is shared
  //    with the Chat tab, which DOES want native scrolling).
  const prevTouchAction = container.style.touchAction;
  const prevOverscroll = container.style.overscrollBehavior;
  container.style.touchAction = "none";
  container.style.overscrollBehavior = "contain";
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
    // Claim the gesture on EVERY move, before the notch check — otherwise the
    // sub-cell opening of a swipe goes un-prevented and the browser grabs it for
    // pull-to-refresh, after which later preventDefaults are ignored.
    e.preventDefault();
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
          deltaY: dir, // one LINE notch; see the dampening note above
          deltaMode: 1, // DOM_DELTA_LINE — bypasses the <50px pixel dampener
          clientX: touchX,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };
  const onTouchEnd = () => {
    touchY = null;
    accum = 0;
  };
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });

  return () => {
    container.style.touchAction = prevTouchAction;
    container.style.overscrollBehavior = prevOverscroll;
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
