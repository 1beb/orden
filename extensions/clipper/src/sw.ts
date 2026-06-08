// Background service worker (MV3, ephemeral, module type).
//
// Arms/disarms "annotation mode" in the active tab. The content script is
// injected on demand under `activeTab` (no broad content_scripts that would
// run on every page). To avoid re-running the whole content module on each
// trigger, we first try to message an already-mounted content script to
// toggle itself off; only if that fails (no receiver yet) do we inject.

const TOGGLE_MESSAGE = { type: "orden-clipper-toggle" } as const;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[orden-clipper] installed");
});

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
