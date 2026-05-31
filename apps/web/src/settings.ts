// App settings, stored in the host vault (ns "settings", key "app"). Accessors
// stay synchronous, backed by a cache hydrated at boot; saveSettings merges a
// patch and writes through to the vault. This is the H0.3 hydration pattern:
// one async load at startup, sync reads thereafter, async write-through.

import type { Host } from "@orden/host-api";
import { FONT_OPTIONS, DEFAULT_FONT_ID } from "./fonts";

export type StartupView = "journal" | "kanban" | "last";

export interface Settings {
  startup: StartupView;
  fontFamily: string; // a FONT_OPTIONS id
  fontSize: number; // px
  accent: string; // hex color (#rrggbb)
  showArchived: boolean; // include archived (Done) sessions in the list
  sessionAutoLaunch: boolean; // auto-spawn the agent TUI when a session is created
}

const STARTUP_VIEWS: readonly StartupView[] = ["journal", "kanban", "last"];
const FONT_IDS = FONT_OPTIONS.map((f) => f.id);
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_ACCENT = "#6d28d9";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_SETTINGS: Settings = {
  startup: "last",
  fontFamily: DEFAULT_FONT_ID,
  fontSize: 16,
  accent: DEFAULT_ACCENT,
  showArchived: false,
  sessionAutoLaunch: true,
};

function isStartupView(value: unknown): value is StartupView {
  return typeof value === "string" && (STARTUP_VIEWS as readonly string[]).includes(value);
}

function coerce(stored: unknown): Settings {
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const size = s.fontSize;
  return {
    startup: isStartupView(s.startup) ? s.startup : DEFAULT_SETTINGS.startup,
    fontFamily:
      typeof s.fontFamily === "string" && FONT_IDS.includes(s.fontFamily)
        ? s.fontFamily
        : DEFAULT_SETTINGS.fontFamily,
    fontSize:
      typeof size === "number" && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE
        ? size
        : DEFAULT_SETTINGS.fontSize,
    accent:
      typeof s.accent === "string" && HEX_COLOR.test(s.accent)
        ? s.accent
        : DEFAULT_SETTINGS.accent,
    showArchived:
      typeof s.showArchived === "boolean" ? s.showArchived : DEFAULT_SETTINGS.showArchived,
    sessionAutoLaunch:
      typeof s.sessionAutoLaunch === "boolean"
        ? s.sessionAutoLaunch
        : DEFAULT_SETTINGS.sessionAutoLaunch,
  };
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

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  cache = { ...cache, ...patch };
  return host ? host.vault.set("settings", "app", cache) : Promise.resolve();
}
