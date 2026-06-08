import type { VaultStore } from "@orden/host-api";
import type { Source } from "@orden/annotation-core";
import { sourceHash } from "@orden/annotation-core";
import { contentHash } from "./contentHash";
import { buildWebAnnotations, type RawHighlight } from "./buildWebAnnotations";
import type { SnapshotStore } from "./snapshotStore";

/** Wire contract: a capture bundle posted by the browser clipper. */
export interface CaptureBundle {
  url: string;
  title: string;
  snapshotHtml: string; // Readability output, block-ids already stamped
  ext: "html";
  highlights: Array<{
    exact: string;
    prefix: string;
    suffix: string;
    blockId: string;
    note: string;
    audience: "agent" | "human";
    shotBase64?: string; // cropped WebP bytes, base64, no data: prefix
  }>;
  routing: { projectId?: string; instructions?: string }; // empty projectId => journal/inbox only
}

export interface ApplyCaptureDeps {
  vault: VaultStore;
  store: SnapshotStore;
  mintId: () => string;
  now: () => string; // ISO timestamp for annotation 'created'
  journalKeyFor: () => string; // today's journal key
  createSession?: (projectId: string, prompt: string) => Promise<string>;
}

export interface ApplyCaptureResult {
  snapshotPath: string;
  contentHash: string;
  annotationCount: number;
  journalKey: string;
  sessionId?: string;
}

/** Turn a capture bundle into a snapshot + annotations + a journal entry + optional session. */
export async function applyCapture(
  deps: ApplyCaptureDeps,
  bundle: CaptureBundle,
): Promise<ApplyCaptureResult> {
  const { vault, store, mintId, now, journalKeyFor } = deps;

  // 1. Persist the snapshot under its content hash.
  // Deliberately the local sync sha256 helper (bare hex), NOT
  // @orden/annotation-core's prefixed/async hash — don't "unify" these.
  const hash = contentHash(bundle.snapshotHtml);
  const snapshotPath = await store.put(hash, bundle.ext, bundle.snapshotHtml);

  // 2. Persist any per-highlight screenshots; map raw highlights → RawHighlight[].
  const raws: RawHighlight[] = [];
  for (let i = 0; i < bundle.highlights.length; i++) {
    const h = bundle.highlights[i];
    let shot: string | undefined;
    if (h.shotBase64) {
      shot = await store.put(`${hash}-${i}`, "webp", Buffer.from(h.shotBase64, "base64"));
    }
    raws.push({
      exact: h.exact,
      prefix: h.prefix,
      suffix: h.suffix,
      blockId: h.blockId,
      note: h.note,
      audience: h.audience,
      ...(shot ? { shot } : {}),
    });
  }

  // 3. Build the web source + WADM annotation records.
  const source: Source = {
    kind: "web",
    url: bundle.url,
    snapshotPath,
    contentHash: hash,
    title: bundle.title,
  };
  const annotations = buildWebAnnotations(source, raws, mintId, now);

  // 4. Write the annotations bundle, keyed by the source's identity hash.
  await vault.set("annotations", sourceHash(source), { source, annotations });

  // 5. Append exactly one top-level journal bullet to today's page.
  const journalKey = journalKeyFor();
  const n = bundle.highlights.length;
  // Sanitize before interpolation: a single bullet must stay a single line, and
  // arbitrary web-page titles must not inject wiki backlinks. Collapse whitespace
  // (incl. newlines) to single spaces, trim, and strip [[/]] from the title.
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const safeTitle = oneLine(bundle.title).replace(/\[\[|\]\]/g, "");
  const safeUrl = oneLine(bundle.url);
  const bullet = `- Clipped: ${safeTitle} — ${safeUrl} (${n} highlight${n === 1 ? "" : "s"})`;
  const prev = (await vault.get<string>("pages", journalKey)) ?? "";
  const next = prev.length > 0 ? `${prev}\n${bullet}` : bullet;
  await vault.set("pages", journalKey, next);

  // 6. Optionally spawn a session, scoped to the routed project.
  let sessionId: string | undefined;
  const projectId = bundle.routing.projectId;
  if (projectId && deps.createSession) {
    const prompt = buildPrompt(bundle);
    sessionId = await deps.createSession(projectId, prompt);
  }

  return { snapshotPath, contentHash: hash, annotationCount: annotations.length, journalKey, sessionId };
}

/** Compose the session prompt from agent-audience notes + routing instructions + url. */
function buildPrompt(bundle: CaptureBundle): string {
  const parts: string[] = [];
  parts.push(`Clipped web page: ${bundle.title}`);
  parts.push(`Source: ${bundle.url}`);
  const agentNotes = bundle.highlights.filter((h) => h.audience === "agent").map((h) => `- ${h.note}`);
  if (agentNotes.length > 0) {
    parts.push("");
    parts.push("Annotations for you:");
    parts.push(...agentNotes);
  }
  if (bundle.routing.instructions && bundle.routing.instructions.trim().length > 0) {
    parts.push("");
    parts.push(bundle.routing.instructions.trim());
  }
  return parts.join("\n");
}
