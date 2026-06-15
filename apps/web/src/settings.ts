// App settings, stored in the host vault (ns "settings", key "app"). Accessors
// stay synchronous, backed by a cache hydrated at boot; saveSettings merges a
// patch and writes through to the vault. This is the H0.3 hydration pattern:
// one async load at startup, sync reads thereafter, async write-through.

import type { Host } from "@orden/host-api";
import { FONT_OPTIONS, DEFAULT_FONT_ID } from "./fonts";

export type StartupView = "journal" | "kanban" | "last";
export type KanbanView = "board" | "list";
export type SessionMode = "tui" | "gui";
export type PrForge = "auto" | "gh" | "glab" | "none";

export interface Settings {
  startup: StartupView;
  kanbanView: KanbanView; // kanban tab layout: column board or grouped list
  fontFamily: string; // a FONT_OPTIONS id
  fontSize: number; // px
  accent: string; // hex color (#rrggbb)
  showArchived: boolean; // include archived (Done) sessions in the list
  sessionAutoLaunch: boolean; // auto-spawn the agent TUI when a session is created
  sessionPanelPct: number; // session panel width as a % of viewport width
  completeFadeHours: number; // hours a card sits in Complete before it dims (one of FADE_HOURS_OPTIONS)
  htmlRender: boolean; // open .html files rendered (true) or as source code (false)
  timeZone: string; // IANA zone for journal day-keys; "" = inherit the host's zone
  defaultMode: { claude: SessionMode; opencode: SessionMode }; // per-tool session UI default (TUI terminal vs native GUI chat)
  showScratchTerminal: boolean; // show the scratch-terminal button in the session pane
  worktreeIsolation: boolean; // launch agent sessions in per-session git worktrees
  worktreeAutoTrust: boolean; // pre-accept claude's workspace-trust dialog for new worktrees (when the repo is trusted)
  worktreeBaseRef: string; // session branch base ref; "" = the repo's default branch (origin/HEAD)
  prForge: PrForge; // PR creation on card completion: auto-infer from the remote, force a CLI, or push-only
  integrationMode: IntegrationMode; // how the merge coordinator integrates a green combined state
  learningPrompt: string; // system prompt given to agents for proposing learnings on completion
}

export type IntegrationMode = "fast" | "measured";

const STARTUP_VIEWS: readonly StartupView[] = ["journal", "kanban", "last"];
const KANBAN_VIEWS: readonly KanbanView[] = ["board", "list"];
const PR_FORGES: readonly PrForge[] = ["auto", "gh", "glab", "none"];
const INTEGRATION_MODES: readonly IntegrationMode[] = ["fast", "measured"];
const FONT_IDS = FONT_OPTIONS.map((f) => f.id);
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 24;
export const MIN_PANEL_PCT = 15;
export const MAX_PANEL_PCT = 50;
export const DEFAULT_ACCENT = "#6d28d9";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// Allowed dwell times before a completed card fades, in hours.
export const FADE_HOURS_OPTIONS: readonly number[] = [1, 4, 8, 24];
// Curated time-zone choices offered in settings, plus "" (inherit the host's
// zone). A short list rather than the full IANA set — these cover the common
// cases; the stored value is still an IANA string, so any zone works if set
// programmatically. Each entry is [IANA id, display label].
export const TIME_ZONE_OPTIONS: readonly (readonly [string, string])[] = [
  ["America/Toronto", "Toronto (Eastern)"],
  ["America/New_York", "New York (Eastern)"],
  ["America/Chicago", "Chicago (Central)"],
  ["America/Denver", "Denver (Mountain)"],
  ["America/Vancouver", "Vancouver (Pacific)"],
  ["Europe/London", "London"],
  ["Europe/Berlin", "Berlin"],
  ["Asia/Tokyo", "Tokyo"],
  ["UTC", "UTC"],
];

// A stored zone is valid if it's "" (inherit) or a zone Intl recognizes.
function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export const DEFAULT_LEARNING_PROMPT =
  "- Right BEFORE card_complete, distill what this session changed into learnings: call learning_propose once per proposed README/ADR/AGENTS.md edit or new skill, passing the FULL post-change file content (not a diff). The user reviews each one. Do NOT propose memories, and skip it when nothing was worth capturing.\n" +
  "- A Comment on a proposed learning is a request to REVISE that learning: re-run learning_propose with that learning's id (passed as the id arg) and the updated full file content — it replaces the proposal in place and returns it to pending for re-review. Do not create a new learning for a revision.";

const DEFAULT_SETTINGS: Settings = {
  startup: "last",
  kanbanView: "board",
  fontFamily: DEFAULT_FONT_ID,
  fontSize: 16,
  accent: DEFAULT_ACCENT,
  showArchived: false,
  sessionAutoLaunch: true,
  sessionPanelPct: 33,
  completeFadeHours: 1,
  htmlRender: true,
  timeZone: "",
  defaultMode: { claude: "tui", opencode: "tui" },
  showScratchTerminal: true,
  worktreeIsolation: true,
  worktreeAutoTrust: true,
  worktreeBaseRef: "",
  prForge: "auto",
  integrationMode: "fast",
  learningPrompt: DEFAULT_LEARNING_PROMPT,
};

function isStartupView(value: unknown): value is StartupView {
  return typeof value === "string" && (STARTUP_VIEWS as readonly string[]).includes(value);
}

function isKanbanView(value: unknown): value is KanbanView {
  return typeof value === "string" && (KANBAN_VIEWS as readonly string[]).includes(value);
}

function isMode(v: unknown): v is SessionMode {
  return v === "tui" || v === "gui";
}

// Coerce a stored per-tool mode map, defaulting each tool to "tui".
function coerceMode(v: unknown): Settings["defaultMode"] {
  const o = (typeof v === "object" && v ? v : {}) as Record<string, unknown>;
  return {
    claude: isMode(o.claude) ? o.claude : "tui",
    opencode: isMode(o.opencode) ? o.opencode : "tui",
  };
}

export function coerce(stored: unknown): Settings {
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const size = s.fontSize;
  const pct = s.sessionPanelPct;
  return {
    startup: isStartupView(s.startup) ? s.startup : DEFAULT_SETTINGS.startup,
    kanbanView: isKanbanView(s.kanbanView) ? s.kanbanView : DEFAULT_SETTINGS.kanbanView,
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
    sessionPanelPct:
      typeof pct === "number" && pct >= MIN_PANEL_PCT && pct <= MAX_PANEL_PCT
        ? pct
        : DEFAULT_SETTINGS.sessionPanelPct,
    completeFadeHours:
      typeof s.completeFadeHours === "number" && FADE_HOURS_OPTIONS.includes(s.completeFadeHours)
        ? s.completeFadeHours
        : DEFAULT_SETTINGS.completeFadeHours,
    htmlRender:
      typeof s.htmlRender === "boolean" ? s.htmlRender : DEFAULT_SETTINGS.htmlRender,
    timeZone: isValidTimeZone(s.timeZone) ? s.timeZone : DEFAULT_SETTINGS.timeZone,
    defaultMode: coerceMode(s.defaultMode),
    showScratchTerminal:
      typeof s.showScratchTerminal === "boolean"
        ? s.showScratchTerminal
        : DEFAULT_SETTINGS.showScratchTerminal,
    worktreeIsolation:
      typeof s.worktreeIsolation === "boolean"
        ? s.worktreeIsolation
        : DEFAULT_SETTINGS.worktreeIsolation,
    worktreeAutoTrust:
      typeof s.worktreeAutoTrust === "boolean"
        ? s.worktreeAutoTrust
        : DEFAULT_SETTINGS.worktreeAutoTrust,
    worktreeBaseRef:
      typeof s.worktreeBaseRef === "string"
        ? s.worktreeBaseRef
        : DEFAULT_SETTINGS.worktreeBaseRef,
    prForge: (PR_FORGES as readonly string[]).includes(s.prForge as string)
      ? (s.prForge as PrForge)
      : DEFAULT_SETTINGS.prForge,
    integrationMode: (INTEGRATION_MODES as readonly string[]).includes(s.integrationMode as string)
      ? (s.integrationMode as IntegrationMode)
      : DEFAULT_SETTINGS.integrationMode,
    learningPrompt:
      typeof s.learningPrompt === "string" && s.learningPrompt.length > 0
        ? s.learningPrompt
        : DEFAULT_SETTINGS.learningPrompt,
  };
}

let host: Host | null = null;
let cache: Settings = { ...DEFAULT_SETTINGS };
// The host's own zone, captured at hydrate. The default journal zone when the
// user hasn't overridden timeZone — so web edits and host-side auto-logs agree.
let hostTimeZone: string | undefined;

/** Load settings from the vault into the cache. Call once at boot. */
export async function hydrateSettings(h: Host): Promise<void> {
  host = h;
  hostTimeZone = h.capabilities().timeZone;
  cache = coerce(await h.vault.get<unknown>("settings", "app"));
}

/**
 * The zone journal day-keys should use: the user's override if set, else the
 * host's zone, else undefined (the runtime's own zone). Pass the result to
 * journalKey(date, tz).
 */
export function effectiveTimeZone(): string | undefined {
  return cache.timeZone || hostTimeZone || undefined;
}

export function loadSettings(): Settings {
  return { ...cache };
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  cache = { ...cache, ...patch };
  return host ? host.vault.set("settings", "app", cache) : Promise.resolve();
}
