// Background service worker (MV3, ephemeral, module type).
//
// Arms/disarms "annotation mode" in the active tab. The content script is
// injected on demand under `activeTab` (no broad content_scripts that would
// run on every page). To avoid re-running the whole content module on each
// trigger, we first try to message an already-mounted content script to
// toggle itself off; only if that fails (no receiver yet) do we inject.

const TOGGLE_MESSAGE = { type: "orden-clipper-toggle" } as const;

// Host URL is configured on the options page and stored in chrome.storage.sync.
// The SERVICE WORKER owns all host fetches (it has host_permissions); the content
// script is cross-origin from the page and would be CORS-blocked, so it routes
// detect/capture through this message bus instead.
const SW_DEFAULT_HOST_URL = "http://127.0.0.1:4319";
const SW_HOST_URL_KEY = "hostUrl";

async function getHostUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.sync.get(SW_HOST_URL_KEY);
    const v = stored?.[SW_HOST_URL_KEY];
    return (typeof v === "string" && v.trim()) || SW_DEFAULT_HOST_URL;
  } catch {
    return SW_DEFAULT_HOST_URL;
  }
}

// Probe the configured host. Resolves ok iff GET /orden-clipper/ping answers with
// the orden marker. A refused connection throws inside fetch — caught here.
async function detect(): Promise<{ ok: boolean; host: string }> {
  const host = await getHostUrl();
  try {
    const res = await fetch(host + "/orden-clipper/ping", {
      headers: { "x-orden-clipper": "1" },
    });
    if (!res.ok) return { ok: false, host };
    const json = await res.json();
    return { ok: json?.app === "orden", host };
  } catch {
    return { ok: false, host };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[orden-clipper] installed");
});

// --- message bus: detect + capture for the content script, on its behalf ---
chrome.runtime.onMessage.addListener(
  (msg: { type?: string; bundle?: unknown }, _sender: unknown, sendResponse: (r: unknown) => void) => {
    if (msg?.type === "orden-detect") {
      void detect().then(sendResponse);
      return true; // keep the channel open for the async response
    }
    if (msg?.type === "orden-capture") {
      void (async () => {
        const host = await getHostUrl();
        try {
          const res = await fetch(host + "/capture", {
            method: "POST",
            headers: { "content-type": "application/json", "x-orden-clipper": "1" },
            body: JSON.stringify(msg.bundle),
          });
          if (res.ok) {
            sendResponse({ ok: true, result: await res.json() });
          } else {
            sendResponse({ ok: false, status: res.status });
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    if (msg?.type === "orden-open-options") {
      try {
        chrome.runtime.openOptionsPage();
      } catch {
        // ignore — best effort
      }
      // no async response needed
    }
    return undefined;
  },
);

async function toggleAnnotationMode(tabId: number): Promise<void> {
  try {
    // If a content script is already mounted it will receive this and tear
    // itself down. sendMessage rejects (no receiving end) when nothing is
    // injected yet — that's our signal to inject.
    await chrome.tabs.sendMessage(tabId, TOGGLE_MESSAGE);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

chrome.action.onClicked.addListener((tab: { id?: number }) => {
  if (typeof tab.id === "number") void toggleAnnotationMode(tab.id);
});

chrome.commands.onCommand.addListener(async (command: string) => {
  if (command !== "toggle-annotation-mode") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && typeof tab.id === "number") void toggleAnnotationMode(tab.id);
});
