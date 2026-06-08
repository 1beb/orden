// POST /capture — the browser clipper's ingestion route.
//
// SECURITY MODEL (loopback trust + CSRF header guard). The host binds only
// loopback + the tailnet IP, never a LAN/public NIC, so any caller is already
// trusted-network. The remaining threat is a MALICIOUS WEB PAGE the user is
// viewing in a normal browser tab driving this route via fetch() to localhost.
// A simple cross-origin POST can't carry a custom request header without first
// triggering a CORS preflight — and the host answers no CORS, so the preflight
// fails and the real request never fires. We exploit that: the clipper sends a
// custom `x-orden-clipper: 1` header, the host REQUIRES it (isClipperRequest),
// and the host NEVER emits any access-control-allow-origin header. The caller in
// serve.ts also answers OPTIONS /capture with 403 (reject the preflight). Net:
// only the extension (which can set arbitrary headers) can drive capture.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CaptureBundle, ApplyCaptureResult } from "./applyCapture";

/**
 * True ONLY for a POST carrying the clipper's custom header. A cross-origin page
 * can't set this header without a preflight the host rejects, so this gate is the
 * CSRF guard (see module header). Header values may arrive as string | string[].
 */
export function isClipperRequest(req: {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (req.method !== "POST") return false;
  const h = req.headers["x-orden-clipper"];
  const v = Array.isArray(h) ? h[0] : h;
  return v === "1";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/** Structural validation of a parsed body into a CaptureBundle. */
function isCaptureBundle(v: unknown): v is CaptureBundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.url !== "string" || b.url.length === 0) return false;
  if (typeof b.title !== "string") return false;
  if (typeof b.snapshotHtml !== "string" || b.snapshotHtml.length === 0) return false;
  if (b.ext !== "html") return false;
  if (!Array.isArray(b.highlights)) return false;
  if (typeof b.routing !== "object" || b.routing === null) return false;
  return true;
}

/**
 * Read + validate a CaptureBundle, run it through `apply`, and respond with the
 * ApplyCaptureResult as JSON (200). Malformed/missing/invalid body => 400; any
 * unexpected error => 500. Never throws out of the handler (mirrors the hooks
 * handler, which always replies rather than surfacing an error to the caller).
 * `apply` is injected so the handler unit-tests without real fs/applyCapture.
 */
export async function handleCaptureRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apply: (bundle: CaptureBundle) => Promise<ApplyCaptureResult>,
): Promise<void> {
  const fail = (code: number, error: string): void =>
    void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  try {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "");
    } catch {
      fail(400, "malformed JSON body");
      return;
    }
    if (!isCaptureBundle(parsed)) {
      fail(400, "invalid capture bundle");
      return;
    }
    const result = await apply(parsed);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch {
    fail(500, "capture failed");
  }
}
