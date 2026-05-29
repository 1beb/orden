// App settings, stored in the host vault (ns "settings", key "app"). Accessors
// stay synchronous, backed by a cache hydrated at boot; saveSettings writes
// through to the vault. This is the H0.3 hydration pattern: one async load at
// startup, sync reads thereafter, async write-through.

import type { Host } from "@orden/host-api";

export type StartupView = "journal" | "kanban" | "last";

export interface Settings {
  startup: StartupView;
}

const STARTUP_VIEWS: readonly StartupView[] = ["journal", "kanban", "last"];
const DEFAULT_SETTINGS: Settings = { startup: "last" };

function isStartupView(value: unknown): value is StartupView {
  return typeof value === "string" && (STARTUP_VIEWS as readonly string[]).includes(value);
}

function coerce(stored: unknown): Settings {
  if (
    typeof stored === "object" &&
    stored !== null &&
    isStartupView((stored as { startup?: unknown }).startup)
  ) {
    return { startup: (stored as Settings).startup };
  }
  return { ...DEFAULT_SETTINGS };
}

let host: Host | null = null;
let cache: Settings = { ...DEFAULT_SETTINGS };

/** Load settings from the vault into the cache. Call once at boot. */
export async function hydrateSettings(h: Host): Promise<void> {
  host = h;
  cache = coerce(await h.vault.get<unknown>("settings", "app"));
}

export function loadSettings(): Settings {
  return { ...cache };
}

export function saveSettings(s: Settings): Promise<void> {
  cache = { startup: s.startup };
  return host ? host.vault.set("settings", "app", cache) : Promise.resolve();
}
