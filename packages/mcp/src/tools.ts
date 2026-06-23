// MCP tool implementations over the Host. Kept transport-agnostic and pure of
// the MCP SDK so they're directly testable; mcp.ts wraps them with schemas.
// Pages are the natural agent-editable surface (vault ns "pages"); vault_* give
// raw access to any namespace.

import type { Host, VaultStore, PublishResult } from "@orden/host-api";
// journalKey flows through the host-api spine (which re-exports the DOM-free
// outliner helper), so mcp doesn't depend on @orden/outliner directly.
import { journalKey } from "@orden/host-api";
import { findCard, cardSessionIds, type CardRec, type SessionRec } from "./sessionLink";
import { putLearning, getLearning, type Learning, type LearningType } from "./learnings";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  // MCP's CallToolResult carries an index signature; mirror it so these results
  // satisfy registerTool's expected return type.
  [key: string]: unknown;
}

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

// Journal day-pages (ISO-date keys) live in the "journal" ns, separate from the
// knowledge "pages" ns. page_read/write route by the name so a date-named page
// resolves to the journal; page_list enumerates the knowledge base only — the
// personal journal is not an agent-listable surface.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const pageNs = (name: string): string => (ISO_DATE.test(name) ? "journal" : "pages");

// Per-page timestamps live in a sidecar ns ("pagemeta"), keyed by page name —
// the same contract the web outliner writes (apps/web/src/pages.ts). The Pages
// index reads this sidecar for each row's created/updated; a page with no sidecar
// renders with no date. So an agent's page_write MUST stamp it too, or
// agent-authored pages show up dateless. A journal day-page seeds `created` from
// its own ISO date (matching the web's dateFallback) so it still sorts sensibly.
interface PageMeta {
  created: string;
  updated: string;
}

export async function pageList(host: Host): Promise<ToolResult> {
  const names = await host.vault.list("pages");
  return text(names.length ? names.sort().join("\n") : "(no pages)");
}

export async function pageRead(host: Host, name: string): Promise<ToolResult> {
  const md = await host.vault.get<string>(pageNs(name), name);
  return text(md ?? `(page not found: ${name})`);
}

export async function pageWrite(host: Host, name: string, markdown: string): Promise<ToolResult> {
  await host.vault.set(pageNs(name), name, markdown);
  const prev = await host.vault.get<PageMeta>("pagemeta", name);
  const now = new Date().toISOString();
  const created = prev?.created ?? (ISO_DATE.test(name) ? `${name}T00:00:00` : now);
  await host.vault.set("pagemeta", name, { created, updated: now } satisfies PageMeta);
  return text(`wrote page "${name}"`);
}

export async function vaultGet(host: Host, ns: string, key: string): Promise<ToolResult> {
  const v = await host.vault.get(ns, key);
  return text(v === null ? `(not found: ${ns}/${key})` : JSON.stringify(v));
}

export async function vaultSet(
  host: Host,
  ns: string,
  key: string,
  json: string,
): Promise<ToolResult> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = json; // not JSON — store the raw string
  }
  await host.vault.set(ns, key, value);
  return text(`set ${ns}/${key}`);
}

export async function vaultList(host: Host, ns: string): Promise<ToolResult> {
  const keys = await host.vault.list(ns);
  return text(keys.length ? keys.sort().join("\n") : "(empty)");
}

// --- merge-resolution verdict ---------------------------------------------
// The protocol an ephemeral resolver agent uses to return its structured verdict
// to the awaiting merge coordinator. The agent (bound to a resolver session)
// calls resolution_report; the host's resolver runner watches MERGE_RESOLUTION_NS
// keyed by that session id and maps the verdict to a ResolverOutcome.

export const MERGE_RESOLUTION_NS = "merge-resolution";

export type ResolutionKind = "resolved" | "intent-conflict" | "unverifiable";

export interface ResolutionVerdict {
  kind: ResolutionKind;
  /** Goal-level question for the user; carried on intent-conflict / unverifiable. */
  question?: string;
}

export async function resolutionReport(
  vault: VaultStore,
  sessionId: string | undefined,
  kind: ResolutionKind,
  question?: string,
): Promise<ToolResult> {
  if (!sessionId)
    return text("resolution_report: this connection isn't bound to a resolver session");
  const verdict: ResolutionVerdict = { kind, ...(question?.trim() ? { question: question.trim() } : {}) };
  await vault.set(MERGE_RESOLUTION_NS, sessionId, verdict);
  return text(`resolution recorded: ${kind}`);
}

// --- kanban / session / project / panel tools -----------------------------
// These take the VaultStore directly (host runtime). Host-minted ids use a
// time+random suffix so they never collide with the web's per-process counter
// ids (item_<time36>_<n> / sess_<time36>_<n>).

interface ProjectRec {
  id: string;
  name: string;
  [k: string]: unknown;
}

export function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve a project id or name to a project id. Match by id, then by name
 * (case-insensitive, trimmed). An unmatched non-empty value THROWS; callers
 * convert the message into a ToolResult error. No value -> fallback or homeroom.
 */
export async function resolveProject(
  vault: VaultStore,
  idOrName?: string,
  fallbackProjectId?: string,
): Promise<string> {
  const ids = await vault.list("projects");
  const projects = (
    await Promise.all(ids.map((id) => vault.get<ProjectRec>("projects", id)))
  ).filter((p): p is ProjectRec => !!p);
  if (idOrName !== undefined && idOrName !== null && String(idOrName).trim() !== "") {
    const byId = projects.find((p) => p.id === idOrName);
    if (byId) return byId.id;
    const t = idOrName.trim().toLowerCase();
    const byName = projects.find((p) => p.name.trim().toLowerCase() === t);
    if (byName) return byName.id;
    throw new Error(
      `unknown project "${idOrName}"; available: ${projects.map((p) => p.name).join(", ")}`,
    );
  }
  return fallbackProjectId ?? "homeroom";
}

const cardMiss = (target: string, candidates: string[]): ToolResult =>
  text(
    `no card matches "${target}"` + (candidates.length ? `; closest: ${candidates.join(", ")}` : ""),
  );

// Each card's narrative lives on a page keyed `card:<id>` (vault ns "pages"),
// mirroring project notes (`notes:<id>`): editable in the outliner, [[linkable]],
// listed in Pages. This replaced the old write-only `card.notes` string.
const cardLogKey = (id: string): string => `card:${id}`;

// The zone auto-log entries are dated in: the user's timeZone override (vault
// settings/app), else the host process's own zone. Mirrors the web's
// effectiveTimeZone so a host-side auto-log and a web edit file under the same
// local day. The shared journalKey (re-exported by @orden/host-api) does the formatting.
async function journalZone(vault: VaultStore): Promise<string | undefined> {
  const s = await vault.get<{ timeZone?: unknown }>("settings", "app");
  if (typeof s?.timeZone === "string" && s.timeZone !== "") return s.timeZone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// HH:MM prefix in the same zone as the day-key, so an entry's time and its page
// date never disagree across a midnight boundary.
function hhmm(d: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: "hour" | "minute"): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const h = get("hour");
  return `${h === "24" ? "00" : h}:${get("minute")}`; // some ICU builds emit 24 at midnight
}

// Append a line to a page, creating it if absent. Pages are plain markdown
// strings in the vault; the web's pages store picks the change up live.
async function appendToPage(vault: VaultStore, key: string, line: string): Promise<void> {
  const cur = (await vault.get<string>("pages", key)) ?? "";
  await vault.set("pages", key, (cur ? cur.trimEnd() + "\n" : "") + line + "\n");
}

// The outliner nests bullets by indentation (2 spaces per level; see
// @orden/outliner's markdown.ts). Auto-written entries are filed as children of a
// single top-level "Automatic Logging" bullet so they read plainly as a machine
// log, separate from anything the user writes at the top level of the page.
const AUTO_SECTION = "Automatic Logging";
const INDENT = "  ";
// The section bullet may carry a trailing Logseq-style property when the user
// collapses it in the outliner (`- Automatic Logging collapsed:: true`); the
// head match must tolerate that or every later write spawns a duplicate section.
// Either bullet marker is accepted (`- ` or `* `): the outliner parser treats
// both as bullets, so legacy/external pages may carry a `* Automatic Logging`
// section that must be recognized as the same one, not duplicated.
const AUTO_SECTION_RE = new RegExp(`^[-*] ${AUTO_SECTION}(?:\\s+\\w+:: .*)?\\s*$`);

// A section is a header line plus the indented lines that immediately follow it
// (its children); a top-level non-section line ends it.
function findAutoSections(lines: string[]): Array<{ header: number; children: number[] }> {
  const secs: Array<{ header: number; children: number[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!AUTO_SECTION_RE.test(lines[i])) continue;
    const children: number[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      if (l.startsWith(" ") || l.startsWith("\t")) children.push(j);
      else break;
    }
    secs.push({ header: i, children });
    i = children.length ? children[children.length - 1] : i;
  }
  return secs;
}

// Heal pages damaged before the collapsed-section fix: fold every duplicate
// "Automatic Logging" section into the first, keeping the first header (and its
// collapsed:: marker) in place. Children are re-emitted in document order, which
// is chronological — sections were created over time and children appended in
// order — so this is correct even for multi-day card logs where the bare HH:MM
// prefixes can't be sorted across a midnight boundary. A no-op below 2 sections.
function mergeAutoSections(cur: string): string {
  if (!cur) return cur;
  const lines = cur.split("\n");
  const secs = findAutoSections(lines);
  if (secs.length < 2) return cur;
  const childIdx = secs.flatMap((s) => s.children);
  const childLines = childIdx.map((i) => lines[i]);
  const drop = new Set<number>(childIdx);
  secs.forEach((s, k) => {
    if (k > 0) drop.add(s.header);
  });
  const firstHeader = secs[0].header;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    out.push(lines[i]);
    if (i === firstHeader) out.push(...childLines);
  }
  let s = out.join("\n");
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

async function appendAutoLog(
  vault: VaultStore,
  key: string,
  entry: string,
  ns = "pages",
): Promise<void> {
  const cur = mergeAutoSections((await vault.get<string>(ns, key)) ?? "");
  const child = `${INDENT}- ${entry}`;
  const lines = cur.split("\n");
  // Idempotent: a byte-identical entry is already logged. Auto entries carry a
  // timestamp + summary, so an exact match within the same minute is a repeat
  // write (MCP double-dispatch, or the direct call and the host reactor both
  // firing for one completion), not two distinct events — collapse to one.
  if (lines.includes(child)) return;
  const head = lines.findIndex((l) => AUTO_SECTION_RE.test(l));
  if (head === -1) {
    const body = cur.trimEnd();
    await vault.set(ns, key, (body ? body + "\n" : "") + `- ${AUTO_SECTION}\n${child}\n`);
    return;
  }
  // Insert after the section's last existing child (a deeper-indented line),
  // before any later top-level content. Blank lines don't end the section.
  let at = head + 1;
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (l.startsWith(" ") || l.startsWith("\t")) at = i + 1;
    else break;
  }
  lines.splice(at, 0, child);
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  await vault.set(ns, key, out);
}

// Canonical project link target, resolving the id to its display name.
async function projectLink(vault: VaultStore, projectId?: string): Promise<string> {
  if (!projectId) return "";
  const p = await vault.get<ProjectRec>("projects", projectId);
  return `[[Project: ${p?.name ?? projectId}]]`;
}

// Session link targets for all sessions linked to a card. Each session gets a
// [[Session: <id>]] wiki link so the journal entry is clickable to the session.
async function sessionLinks(vault: VaultStore, card: CardRec): Promise<string[]> {
  const ids = cardSessionIds(card);
  if (ids.length === 0) return [];
  return ids.map((sid) => `[[Session: ${sid}]]`);
}

export async function cardGet(vault: VaultStore, target: string): Promise<ToolResult> {
  const { card, candidates } = await findCard(vault, target);
  if (!card) return cardMiss(target, candidates);
  // Prefer the log page; fall back to a legacy notes string for old cards.
  const log =
    (await vault.get<string>("pages", cardLogKey(card.id))) ??
    (typeof card.notes === "string" ? card.notes : "");
  return text(
    JSON.stringify(
      {
        id: card.id,
        title: card.title,
        state: card.state,
        project: card.projectId,
        log,
        ...(typeof card.description === "string" && card.description
          ? { description: card.description }
          : {}),
        ...(typeof card.planDoc === "string" && card.planDoc ? { planDoc: card.planDoc } : {}),
      },
      null,
      2,
    ),
  );
}

export async function cardMove(
  vault: VaultStore,
  target: string,
  state: "planning" | "in-progress" | "blocked",
  note?: string,
): Promise<ToolResult> {
  const { card, candidates } = await findCard(vault, target);
  if (!card) return cardMiss(target, candidates);
  await vault.set("cards", card.id, { ...card, state });
  if (note) {
    const tz = await journalZone(vault);
    await appendAutoLog(vault, cardLogKey(card.id), `${hhmm(new Date(), tz)} ${state}: ${note}`);
  }
  return text(`card "${card.title}" -> ${state}`);
}

// Write a completed card's two auto-log entries: a "Completed" line on the
// card's own log page, and a journal entry on the day-page linking the project.
//
// Driven entirely off the card record (`completedAt`, `completionSummary`), so
// it is deterministic and idempotent: whether the MCP `card_complete` tool calls
// it directly, or the host's journal reactor calls it off the vault change a web
// completion produced, both compute the byte-identical entry — and
// appendAutoLog's exact-duplicate guard collapses the pair to one. This is the
// single source of completion logging; both completion paths route through it.
export async function logCardCompletion(vault: VaultStore, card: CardRec): Promise<void> {
  const when = typeof card.completedAt === "number" ? new Date(card.completedAt) : new Date();
  const tz = await journalZone(vault);
  const time = hhmm(when, tz);
  const sum =
    typeof card.completionSummary === "string" ? card.completionSummary.trim() : "";

  // Card log: a Completed line, with the summary when given.
  await appendAutoLog(vault, cardLogKey(card.id), `${time} Completed${sum ? " — " + sum : ""}`);

  // Journal: a single entry on the completion day's page linking back to the
  // project and sessions (and the plan doc, when one is associated).
  const link = await projectLink(vault, card.projectId);
  const sessions = await sessionLinks(vault, card);
  const plan =
    typeof card.planDoc === "string" && card.planDoc ? ` · plan: ${card.planDoc}` : "";
  const entry =
    [`${time} Completed "${card.title}"`, sum ? `— ${sum}` : "", link, ...sessions]
      .filter(Boolean)
      .join(" ") +
    plan;
  await appendAutoLog(vault, journalKey(when, tz), entry, "journal");
}

// Ranking for picking the card-level publish stamp when a card has several
// sessions: surface the most "published" outcome.
const PUBLISH_RANK: Record<PublishResult["state"], number> = {
  clean: 6, // verified clean, awaiting coordinator integration — the success state
  "pr-opened": 5,
  pushed: 4,
  "push-failed": 3,
  "no-remote": 2,
  dirty: 1,
  "ran-in-shared": 1, // session ran in the shared checkout — refuses completion like dirty
  "no-worktree": 0,
};

export async function cardComplete(
  vault: VaultStore,
  target: string,
  summary?: string,
  opts?: {
    /** Complete even with unpublished/dirty work — only on the user's explicit say-so. */
    force?: boolean;
    /**
     * The host's capability-gated publish service (Host.publish). Absent when
     * running standalone / on a host without git — completion then behaves
     * exactly as before the publish gate existed.
     */
    publish?: (sessionId: string, meta: { title: string; summary?: string }) => Promise<PublishResult>;
  },
): Promise<ToolResult> {
  const { card, candidates } = await findCard(vault, target);
  if (!card) return cardMiss(target, candidates);

  // Publish gate: committed-and-pushed is the only durable exit state for
  // session work. Runs BEFORE the state flips so a dirty worktree can refuse
  // the completion (a post-write reactor could not block it).
  let best: PublishResult | undefined;
  if (opts?.publish) {
    const results: PublishResult[] = [];
    for (const sessionId of cardSessionIds(card)) {
      results.push(await opts.publish(sessionId, { title: card.title, summary: summary?.trim() || undefined }));
    }
    const real = results.filter((r) => r.state !== "no-worktree");
    const dirty = real.find((r) => r.state === "dirty");
    if (dirty && !opts.force) {
      return text(
        `cannot complete: session worktree has uncommitted changes on branch ${dirty.branch ?? "(unknown)"}.\n` +
          `Commit your work (git add <files> && git commit) in the worktree, then call card_complete again.\n` +
          `Pass force:true ONLY if the user explicitly said to complete without publishing.`,
      );
    }
    const ranInShared = real.find((r) => r.state === "ran-in-shared");
    if (ranInShared && !opts.force) {
      return text(
        `cannot complete: session appears to have run in the shared checkout, not its worktree ` +
          `(branch ${ranInShared.branch ?? "(unknown)"}).\n` +
          `The worktree is clean because the work landed in main, not because it's committed. ` +
          `Investigate where the session actually ran before completing.\n` +
          `Pass force:true ONLY if the user explicitly said to complete anyway.`,
      );
    }
    best = real.sort((a, b) => PUBLISH_RANK[b.state] - PUBLISH_RANK[a.state])[0];
  }

  // Stamp completion + stash the summary on the card so logCardCompletion (and
  // the host reactor, which fires off this very write) can render it. We also
  // log directly here so the journal lands even when no reactor is wired (the
  // MCP package standalone, or a non-NodeHost); the reactor's call is a no-op
  // duplicate, collapsed by appendAutoLog.
  const completed: CardRec = {
    ...card,
    state: "complete",
    completedAt: Date.now(),
    completionSummary: summary?.trim() || undefined,
    ...(best
      ? {
          publishState: best.state,
          ...(best.branch ? { branch: best.branch } : {}),
          ...(best.prUrl ? { prUrl: best.prUrl } : {}),
          ...(best.compareUrl ? { compareUrl: best.compareUrl } : {}),
          ...(best.error ? { publishError: best.error } : {}),
        }
      : {}),
  };
  await vault.set("cards", card.id, completed);
  await logCardCompletion(vault, completed);
  const pub = !best
    ? ""
    : best.state === "pr-opened"
      ? ` (branch ${best.branch} pushed, PR ${best.prUrl})`
      : best.state === "pushed"
        ? ` (branch ${best.branch} pushed${best.compareUrl ? `, compare: ${best.compareUrl}` : ""})`
        : ` (publish: ${best.state}${best.error ? ` — ${best.error}` : ""})`;
  return text(`card "${card.title}" -> complete${pub}`);
}

// Associate a planning document (a docs/plans/*.md repo file) with a card. The
// path is validated against the card's project so a typo doesn't silently stick.
export async function cardSetPlan(host: Host, target: string, path: string): Promise<ToolResult> {
  const { card, candidates } = await findCard(host.vault, target);
  if (!card) return cardMiss(target, candidates);
  const p = path.trim();
  if (!p.startsWith("docs/plans/")) {
    return text(`plan path must be under docs/plans/ (got "${p}")`);
  }
  if (!card.projectId) {
    return text(`card "${card.title}" has no project; cannot resolve plan file`);
  }
  try {
    await host.files.read(card.projectId, p);
  } catch {
    return text(`plan file not found: ${p}`);
  }
  await host.vault.set("cards", card.id, { ...card, planDoc: p });
  return text(`card "${card.title}" plan -> ${p}`);
}

export async function cardCreate(
  vault: VaultStore,
  title: string,
  projectIdOrName?: string,
  notes?: string,
  description?: string,
): Promise<ToolResult> {
  let projectId: string;
  try {
    projectId = await resolveProject(vault, projectIdOrName);
  } catch (err) {
    return text((err as Error).message);
  }
  const id = rid("item");
  const card: CardRec = {
    id,
    title: title.trim(),
    state: "planning",
    projectId,
    sessionIds: [],
    ...(description?.trim() ? { description: description.trim() } : {}),
  };
  await vault.set("cards", id, card);
  // Seed the card log page with the opening notes rather than the retired
  // `card.notes` field.
  if (notes?.trim()) await appendToPage(vault, cardLogKey(id), notes.trim());
  return text(`created card "${card.title}" in planning (${id})`);
}

// Delete a card record outright from vault ns "cards", mirroring the web's
// removeItem: only the record goes; linked sessions are first-class and
// survive. Unlike the other card tools this NEVER falls back to the current
// session's card — deletion demands an explicit target — and a title shared by
// several cards is refused rather than resolved to the first match.
export async function cardDelete(vault: VaultStore, target: string): Promise<ToolResult> {
  const t = target?.trim() ?? "";
  if (!t) return text("card_delete requires an explicit card id or title");
  const ids = await vault.list("cards");
  const cards = (await Promise.all(ids.map((id) => vault.get<CardRec>("cards", id)))).filter(
    (c): c is CardRec => !!c,
  );
  let card = cards.find((c) => c.id === t);
  if (!card) {
    const tl = t.toLowerCase();
    const byTitle = cards.filter((c) => c.title.trim().toLowerCase() === tl);
    if (byTitle.length > 1) {
      return text(
        `"${t}" matches ${byTitle.length} cards (${byTitle.map((c) => c.id).join(", ")}); pass a card id`,
      );
    }
    card = byTitle[0];
  }
  if (!card) {
    const candidates = cards
      .filter((c) => c.title.toLowerCase().includes(t.toLowerCase()))
      .map((c) => c.title)
      .slice(0, 5);
    return cardMiss(t, candidates);
  }
  await vault.delete("cards", card.id);
  const linked = cardSessionIds(card);
  return text(
    `deleted card "${card.title}" (${card.id})` +
      (linked.length ? `; linked sessions left intact: ${linked.join(", ")}` : ""),
  );
}

export async function projectList(vault: VaultStore): Promise<ToolResult> {
  const ids = await vault.list("projects");
  const projects = (
    await Promise.all(ids.map((id) => vault.get<ProjectRec>("projects", id)))
  ).filter((p): p is ProjectRec => !!p);
  if (!projects.length) return text("(no projects)");
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return text(projects.map((p) => `${p.id}  ${p.name}`).join("\n"));
}

export async function sessionCreate(
  vault: VaultStore,
  opts: { title: string; projectIdOrName?: string; prompt?: string; agent?: string },
): Promise<ToolResult> {
  let projectId: string;
  try {
    projectId = await resolveProject(vault, opts.projectIdOrName);
  } catch (err) {
    return text((err as Error).message);
  }
  const sessionId = rid("sess");
  const prompt = opts.prompt?.trim();
  const title = opts.title.trim() || "Untitled session";
  // Auto-launch is ON unless explicitly disabled. When on, flag the record so
  // the host spawns a detached agent for it; web-created sessions never set this.
  const settings = await vault.get<{ sessionAutoLaunch?: boolean }>("settings", "app");
  const autoLaunch = settings?.sessionAutoLaunch !== false;
  const session: SessionRec = {
    id: sessionId,
    title,
    agent: opts.agent ?? "claude",
    projectId,
    ...(prompt ? { initialPrompt: prompt } : {}),
    ...(autoLaunch ? { pendingLaunch: true } : {}),
  };
  await vault.set("sessions", sessionId, session);
  // separate-but-linked: drop a planning card pointing back to this session.
  const cardId = rid("item");
  const card: CardRec = {
    id: cardId,
    title,
    state: "planning",
    projectId,
    sessionIds: [sessionId],
  };
  await vault.set("cards", cardId, card);
  return text(
    autoLaunch
      ? `created session "${title}" + planning card (launching) (${sessionId})`
      : `created session "${title}" + planning card (${sessionId})`,
  );
}

// Render a project-relative doc on the host (quarto) and report build status.
// Deliberately does NOT open anything: a separate panel_open call surfaces the
// output once the render is verified. Gated by host.render (capabilities.docRender).
export async function docRender(host: Host, projectId: string, path: string): Promise<ToolResult> {
  if (!host.render)
    return text("doc_render unavailable: this host cannot render (quarto not installed?)");
  const r = await host.render(projectId, path);
  if (r.ok) return text(`rendered ${path} -> ${r.outputPath}`);
  return text(`render FAILED for ${path}:\n${r.errors ?? "unknown error"}`);
}

// Capture one proposed learning — a concrete README/ADR/AGENTS edit or a new
// skill distilled from a session — as a pending record for the user to review.
// Binding (card/project/session) is resolved by the caller and passed in, so the
// fn stays unit-testable; `now` and `id` are injected for deterministic tests.
// The current file content (when present) is stashed as baseContent for the
// diff, and decides edit-vs-create.
//
// REVISE-in-place: when `id` names an EXISTING learning (the user commented and
// the agent is re-iterating), the record is UPDATED — its id/binding/createdAt
// and the user's comments are preserved, the proposal fields are replaced,
// baseContent is re-derived, and status returns to "pending" for re-review. With
// an absent or unknown id, a fresh record is created exactly as before.
export async function learningPropose(
  host: Host,
  binding: { cardId: string; projectId: string; sessionId?: string },
  input: { type: LearningType; title: string; recap: string; path: string; content: string },
  now: number,
  id: string,
): Promise<ToolResult> {
  let baseContent: string | undefined;
  let op: "edit" | "create" = "create";
  try {
    baseContent = await host.files.read(binding.projectId, input.path);
    op = "edit";
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    op = "create"; // file genuinely absent
  }

  const existing = await getLearning(host.vault, id);
  // A learning may only be revised by the card that owns it. If the id names a
  // learning bound to a DIFFERENT card, refuse — never overwrite (creating with
  // this id would clobber it just as much as updating, since the vault is keyed
  // by id), so this is the only safe response.
  if (existing && existing.cardId !== binding.cardId) {
    return text(`learning ${id} belongs to a different card; not modifying it`);
  }
  if (existing) {
    // Revision: preserve identity/binding/history, replace the proposal.
    const updated: Learning = {
      ...existing,
      type: input.type,
      title: input.title.trim(),
      recap: input.recap.trim(),
      targetPath: input.path,
      op,
      proposedContent: input.content,
      baseContent,
      status: "pending",
    };
    await putLearning(host.vault, updated);
    return text(`revised learning ${id}: ${updated.title} (${op} ${updated.targetPath})`);
  }

  const learning: Learning = {
    id,
    cardId: binding.cardId,
    sessionId: binding.sessionId,
    projectId: binding.projectId,
    type: input.type,
    title: input.title.trim(),
    recap: input.recap.trim(),
    targetPath: input.path,
    op,
    proposedContent: input.content,
    baseContent,
    status: "pending",
    createdAt: now,
  };
  await putLearning(host.vault, learning);
  return text(`proposed learning ${id}: ${learning.title} (${op} ${learning.targetPath})`);
}

export async function panelOpen(
  vault: VaultStore,
  kind: "doc" | "page" | "kanban" | "card",
  target: string,
  // The file root a doc target resolves under (e.g. "session:<id>" for a
  // session's worktree). Absent = the web's default ("repo").
  projectId?: string,
): Promise<ToolResult> {
  // nonce must differ on every call so the web's change feed fires even when the
  // same kind/target is opened twice in a row. Date.now() alone collides within a
  // millisecond; append a random suffix to make it strictly distinct.
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await vault.set("ui", "panel-intent", { kind, target, nonce, ...(projectId ? { projectId } : {}) });
  return text(target ? `opened ${kind} in panel: ${target}` : `opened ${kind} in panel`);
}
