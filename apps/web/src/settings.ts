export type StartupView = "journal" | "kanban" | "last";

export interface Settings {
  startup: StartupView;
}

const STORAGE_KEY = "orden:settings";

const STARTUP_VIEWS: readonly StartupView[] = ["journal", "kanban", "last"];

const DEFAULT_SETTINGS: Settings = { startup: "last" };

function isStartupView(value: unknown): value is StartupView {
  return (
    typeof value === "string" &&
    (STARTUP_VIEWS as readonly string[]).includes(value)
  );
}

export function loadSettings(): Settings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return { ...DEFAULT_SETTINGS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    isStartupView((parsed as { startup?: unknown }).startup)
  ) {
    return { startup: (parsed as Settings).startup };
  }

  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
