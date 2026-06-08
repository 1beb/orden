// Options page: persist the orden host URL to chrome.storage.sync.

const DEFAULT_HOST_URL = "http://127.0.0.1:4319";
const STORAGE_KEY = "hostUrl";

const input = document.getElementById("host-url") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

async function load(): Promise<void> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  input.value = (stored?.[STORAGE_KEY] as string | undefined) ?? DEFAULT_HOST_URL;
}

async function save(): Promise<void> {
  const value = input.value.trim() || DEFAULT_HOST_URL;
  await chrome.storage.sync.set({ [STORAGE_KEY]: value });
  input.value = value;
  statusEl.hidden = false;
  setTimeout(() => {
    statusEl.hidden = true;
  }, 1500);
}

saveBtn.addEventListener("click", () => void save());
void load();
