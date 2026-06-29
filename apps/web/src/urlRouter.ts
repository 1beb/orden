// Hash-based deep-linking for the web shell. The current view's navigational
// identity — which view, project, document, and page is open — is mirrored into
// the URL hash so a link reproduces the exact surface elsewhere (another
// tab/device, or handed to a colleague, even on a different instance).
//
// Identifiers are PORTABLE HANDLES, never instance-local ids: projects are
// referenced by name (resolved case-insensitively at apply time), docs by their
// path within the project, pages by name. A live agent session has no portable
// identity (it's bound to one machine), so it is deliberately NOT in the hash —
// "which session is open" stays in the vault (ui/last-session) for in-instance
// reload. The handle scheme is centralized here and in the project resolver, so
// swapping name → immutable slug (or org/repo) later changes one place, not the
// URL format.
//
// Scope is NAVIGATIONAL ONLY: transient personal layout (left-nav collapsed,
// session-pane width, focus mode, context-panel toggles) also stays in the vault
// so a shared link never imposes someone's layout on the recipient. The hash is
// the shareable identity; the vault is the personal pose.
//
// Format: `#/<view>?<query>` where view is always present and query carries the
// optional refs. Examples:
//   #/kanban
//   #/project?p=orden
//   #/code?p=orden&d=src/main.ts
//   #/review?d=/abs/host/file.md            (absolute path → host root)
//   #/journal?page=2026-06-27
//
// Back/forward works: each user navigation pushStates a new entry (a burst of
// synchronous state changes from one gesture coalesces into a single entry via a
// microtask flush). Editing the URL bar / pasting a link in-tab fires hashchange
// and is applied too.

import { VIEWS, type View } from "./viewState";

export interface NavState {
  view: View;
  /** Active project NAME (portable handle), for project/project-settings views
   * and as the default owner of an open doc. Resolved to an id at apply time. */
  project?: string;
  /** Open repo file path (code/image/html/review viewers). */
  docPath?: string;
  /** NAME of the doc's project, only when it differs from `project` (e.g. an
   * absolute host-rooted file, or a file opened under a different project). */
  docProject?: string;
  /** A journal/pages page name (the journal is in page mode when set). */
  page?: string;
}

const VIEW_SET = new Set<string>(VIEWS);

function isView(v: string): v is View {
  return VIEW_SET.has(v);
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Serialize navigational state into a hash string. */
export function serializeNav(state: NavState): string {
  const params = new URLSearchParams();
  if (state.project) params.set("p", state.project);
  if (state.docPath) {
    params.set("d", state.docPath);
    if (state.docProject && state.docProject !== state.project) {
      params.set("dp", state.docProject);
    }
  }
  if (state.page) params.set("page", state.page);
  const q = params.toString();
  return q ? `#/${state.view}?${q}` : `#/${state.view}`;
}

/**
 * Parse a hash into navigational state. Returns null for an empty/unknown hash
 * (no view to restore) — callers treat null as "no deep link, use the vault".
 */
export function parseNav(hash: string): NavState | null {
  // Accept "#/kanban?…", "#kanban?…", or "kanban?…".
  const h = hash.replace(/^#?\/?/, "");
  if (!h) return null;
  const [viewRaw, qs] = splitOnce(h, "?");
  const view = decodeURIComponent(viewRaw);
  if (!isView(view)) return null;
  const params = new URLSearchParams(qs ?? "");
  const state: NavState = { view };
  const project = params.get("p") ?? undefined;
  const docPath = params.get("d") ?? undefined;
  const docProject = params.get("dp") ?? undefined;
  const page = params.get("page") ?? undefined;
  if (project) state.project = project;
  if (docPath) {
    state.docPath = docPath;
    // dp is ONLY written when the doc lives in a different project than the
    // active one; keep parse faithful to the URL. applyNav resolves the
    // effective project via its own fallback chain.
    if (docProject) state.docProject = docProject;
  }
  if (page) state.page = page;
  return state;
}

export interface UrlRouterDeps {
  /** Read the current navigational state from the live app. */
  snapshot: () => NavState;
  /** Drive the app's openers to match a parsed state (may be async). */
  apply: (state: NavState) => Promise<void> | void;
}

export interface UrlRouter {
  /** Signal that a navigation happened; coalesces into one pushState entry. */
  notify(): void;
  /** Replace the current URL entry (no new history) — reconciles after a
   * URL-driven apply or when normalizing. */
  replace(): void;
  /** On boot: if the URL carries state, apply it (URL wins) and return true. */
  applyInitial(): Promise<boolean>;
}

/**
 * Build the URL sync controller. Subscribes to popstate (back/forward over our
 * pushState entries) and hashchange (manual URL edits / pasted links), applying
 * the parsed state on each.
 */
export function createUrlRouter(deps: UrlRouterDeps): UrlRouter {
  let scheduled = false;
  // True while restoring from the URL → suppress pushState so applying a deep
  // link (which itself fires openers → notify) doesn't spawn history entries.
  let applying = false;
  let last = serializeNav(deps.snapshot());

  function flushPush(): void {
    scheduled = false;
    if (applying) return;
    const next = serializeNav(deps.snapshot());
    if (next === last) return;
    last = next;
    try {
      history.pushState({ orden: next }, "", next);
    } catch {
      // pushState can throw in sandboxed contexts; fail soft rather than break
      // navigation — the URL simply won't advance.
    }
  }

  function notify(): void {
    if (applying) return;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flushPush);
  }

  function replace(): void {
    last = serializeNav(deps.snapshot());
    try {
      history.replaceState({ orden: last }, "", last);
    } catch {
      /* ignore */
    }
  }

  async function applyFromUrl(): Promise<void> {
    const state = parseNav(location.hash);
    if (!state) return;
    applying = true;
    try {
      await deps.apply(state);
    } finally {
      applying = false;
      // Reconcile: the openers may have landed somewhere other than the URL
      // (e.g. a session/doc/project that no longer exists) — serialize what we
      // actually reached and replace, so the URL stays truthful.
      replace();
    }
  }

  async function applyInitial(): Promise<boolean> {
    if (!parseNav(location.hash)) return false;
    await applyFromUrl();
    return true;
  }

  window.addEventListener("popstate", () => void applyFromUrl());
  // pushState/replaceState never fire hashchange; only real hash edits do.
  // Catch those so pasting/editing a link in-tab restores it immediately.
  window.addEventListener("hashchange", () => void applyFromUrl());

  return { notify, replace, applyInitial };
}
