// Content script: arms/disarms orden "annotation mode" in the page.
//
// Mounts a Shadow-DOM overlay (so the host page CSS cannot bleed in) with a
// small fixed banner. Re-injecting this module while already mounted toggles
// OFF instead of stacking, via a window-level flag the SW also relies on.
//
// No host calls yet — this task is only arm/disarm.

const MOUNT_FLAG = "__ordenClipperMounted";
const HOST_ID = "orden-clipper-overlay-host";

interface ClipperWindow extends Window {
  [MOUNT_FLAG]?: boolean;
}

const w = window as ClipperWindow;

// Teardown handles kept at module scope so unmount can detach listeners.
let hostEl: HTMLDivElement | null = null;
let onKeydown: ((e: KeyboardEvent) => void) | null = null;
let onMessage:
  | ((msg: { type?: string }, sender: unknown, sendResponse: () => void) => void)
  | null = null;

function unmount(): void {
  if (onKeydown) {
    document.removeEventListener("keydown", onKeydown, true);
    onKeydown = null;
  }
  if (onMessage && chrome?.runtime?.onMessage) {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // ignore — listener may already be gone
    }
    onMessage = null;
  }
  const existing = hostEl ?? document.getElementById(HOST_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  hostEl = null;
  w[MOUNT_FLAG] = false;
}

function mount(): void {
  const host = document.createElement("div");
  host.id = HOST_ID;
  // The host element itself stays neutral; all UI lives inside the shadow root.
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "0";
  host.style.height = "0";
  host.style.zIndex = "2147483647";
  document.documentElement.appendChild(host);
  hostEl = host;

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .banner {
      position: fixed;
      top: 12px;
      right: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #1f2937;
      color: #f9fafb;
      font: 13px/1.2 -apple-system, system-ui, sans-serif;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      pointer-events: auto;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 6px #34d399;
      flex: 0 0 auto;
    }
    .label { white-space: nowrap; }
    .exit {
      margin-left: 4px;
      padding: 3px 9px;
      background: #374151;
      color: #f9fafb;
      border: 1px solid #4b5563;
      border-radius: 5px;
      font: inherit;
      cursor: pointer;
    }
    .exit:hover { background: #4b5563; }
  `;
  shadow.appendChild(style);

  const banner = document.createElement("div");
  banner.className = "banner";

  const dot = document.createElement("span");
  dot.className = "dot";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "orden — annotation mode";

  const exit = document.createElement("button");
  exit.className = "exit";
  exit.type = "button";
  exit.textContent = "Exit";
  exit.addEventListener("click", () => unmount());

  banner.append(dot, label, exit);
  shadow.appendChild(banner);

  // Escape exits. Capture phase so the page can't swallow it first.
  onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      unmount();
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  // Toggle message from the service worker (or a re-trigger).
  onMessage = (msg, _sender, sendResponse) => {
    if (msg?.type === "orden-clipper-toggle") {
      unmount();
      sendResponse();
    }
  };
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(onMessage);
  }

  w[MOUNT_FLAG] = true;
}

// Entry: if already mounted (module re-injected), toggle OFF; else mount.
if (w[MOUNT_FLAG]) {
  unmount();
} else {
  mount();
}
