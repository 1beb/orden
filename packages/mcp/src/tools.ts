// MCP tool implementations over the Host. Kept transport-agnostic and pure of
// the MCP SDK so they're directly testable; mcp.ts wraps them with schemas.
// Pages are the natural agent-editable surface (vault ns "pages"); vault_* give
// raw access to any namespace.

import type { Host, VaultStore } from "@orden/host-api";
import { findCard, type CardRec, type SessionRec } from "./sessionLink";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  // MCP's CallToolResult carries an index signature; mirror it so these results
  // satisfy registerTool's expected return type.
  [key: string]: unknown;
}

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

export async function pageList(host: Host): Promise<ToolResult> {
  const names = await host.vault.list("pages");
  return text(names.length ? names.sort().join("\n") : "(no pages)");
}

export async function pageRead(host: Host, name: string): Promise<ToolResult> {
  const md = await host.vault.get<string>("pages", name);
  return text(md ?? `(page not found: ${name})`);
}

export async function pageWrite(host: Host, name: string, markdown: string): Promise<ToolResult> {
  await host.vault.set("pages", name, markdown);
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

// --- kanban / session / project / panel tools -----------------------------
// These take the VaultStore directly (host runtime). Host-minted ids use a
// time+random suffix so they never collide with the web's per-process counter
// ids (item_<time36>_<n> / sess_<time36>_<n>).

interface ProjectRec {
  id: string;
  name: string;
  [k: string]: unknown;
}

function rid(prefix: string): string {
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

// ISO date key for today's journal page (UTC), matching outliner's journalKey.
const journalKey = (d: Date): string => d.toISOString().slice(0, 10);
// UTC HH:MM prefix; consistent with the UTC date key so an entry never lands on
// the wrong day's page.
const hhmm = (d: Date): string => d.toISOString().slice(11, 16);

// Append a line to a page, creating it if absent. Pages are plain markdown
// strings in the vault; the web's pages store picks the change up live.
async function appendToPage(vault: VaultStore, key: string, line: string): Promise<void> {
  const cur = (await vault.get<string>("pages", key)) ?? "";
  await vault.set("pages", key, (cur ? cur.trimEnd() + "\n" : "") + line + "\n");
}

// Canonical project link target, resolving the id to its display name.
async function projectLink(vault: VaultStore, projectId?: string): Promise<string> {
  if (!projectId) return "";
  const p = await vault.get<ProjectRec>("projects", projectId);
  return `[[Project: ${p?.name ?? projectId}]]`;
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
  if (note) await appendToPage(vault, cardLogKey(card.id), `- ${hhmm(new Date())} ${state}: ${note}`);
  return text(`card "${card.title}" -> ${state}`);
}

export async function cardComplete(
  vault: VaultStore,
  target: string,
  summary?: string,
): Promise<ToolResult> {
  const { card, candidates } = await findCard(vault, target);
  if (!card) return cardMiss(target, candidates);
  await vault.set("cards", card.id, { ...card, state: "complete" });

  const now = new Date();
  const time = hhmm(now);
  const sum = summary?.trim();

  // Card log: a Completed line, with the summary when given.
  await appendToPage(vault, cardLogKey(card.id), `- ${time} Completed${sum ? " — " + sum : ""}`);

  // Journal: a single bullet on today's page linking back to the project (and
  // the plan doc, when one is associated).
  const link = await projectLink(vault, card.projectId);
  const plan =
    typeof card.planDoc === "string" && card.planDoc ? ` · plan: ${card.planDoc}` : "";
  const bullet =
    [`- ${time} Completed "${card.title}"`, sum ? `— ${sum}` : "", link].filter(Boolean).join(" ") +
    plan;
  await appendToPage(vault, journalKey(now), bullet);

  return text(`card "${card.title}" -> complete`);
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
  };
  await vault.set("cards", id, card);
  // Seed the card log page with the opening notes rather than the retired
  // `card.notes` field.
  if (notes?.trim()) await appendToPage(vault, cardLogKey(id), notes.trim());
  return text(`created card "${card.title}" in planning (${id})`);
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

export async function panelOpen(
  vault: VaultStore,
  kind: "doc" | "page" | "kanban" | "card",
  target: string,
): Promise<ToolResult> {
  // nonce must differ on every call so the web's change feed fires even when the
  // same kind/target is opened twice in a row. Date.now() alone collides within a
  // millisecond; append a random suffix to make it strictly distinct.
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await vault.set("ui", "panel-intent", { kind, target, nonce });
  return text(target ? `opened ${kind} in panel: ${target}` : `opened ${kind} in panel`);
}
