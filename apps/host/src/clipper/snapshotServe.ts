// GET /snapshot/<vault-relative-path> → stored snapshot HTML or screenshot bytes,
// served read-only and same-origin so orden's main panel (and agents) can load a
// frozen capture and its per-highlight screenshots. The whole substring after
// "/snapshot/" IS the vault-relative path (the SIMPLER mapping: no segment
// rewriting), so a stored snapshotPath like "snapshots/abc.html" maps directly to
// "/snapshot/snapshots/abc.html".
//
// The path is attacker-influenced (it comes from a stored annotation's
// snapshotPath), so the guard is strict: it must begin with "snapshots/", contain
// no ".." segment, and end in a served extension (.html or .webp). Anything else
// is refused before the store is touched.

import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { SnapshotStore } from "./snapshotStore";

const PREFIX = "/snapshot/";

// True if any "/"-separated segment is exactly "..". Catches "snapshots/../x",
// a trailing "snapshots/.." etc. We never need ".." in a snapshot path, so a
// blanket reject is correct (and stricter than relative()-based containment).
function hasDotDotSegment(rel: string): boolean {
  return rel.split("/").some((seg) => seg === "..");
}

export async function handleSnapshotRequest(
  store: SnapshotStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const url = req.url ?? "";
    const path = url.split("?")[0];
    if (!path.startsWith(PREFIX)) {
      res.writeHead(400).end("bad request");
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(path.slice(PREFIX.length));
    } catch {
      res.writeHead(400).end("bad request"); // malformed percent-encoding
      return;
    }
    // Traversal + scope guard: must live under snapshots/ with no ".." segment.
    if (!rel.startsWith("snapshots/") || hasDotDotSegment(rel)) {
      res.writeHead(400).end("bad request");
      return;
    }
    const ext = extname(rel).toLowerCase();
    if (ext === ".html") {
      const body = await store.get(rel);
      if (body === null) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
      });
      res.end(body);
      return;
    }
    if (ext === ".webp") {
      const body = await store.getBytes(rel);
      if (body === null) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "image/webp",
        "cache-control": "no-cache, must-revalidate",
      });
      res.end(body);
      return;
    }
    // Only html + webp are served; anything else is refused.
    res.writeHead(400).end("bad request");
  } catch {
    res.writeHead(500).end("internal error");
  }
}
