// GET /repo-file/<repo-relative-path> → raw file bytes. The web app's image
// viewer points <img src> here, because the RPC files.read() is utf8-only and
// would corrupt binary content. Text files (e.g. HTML source) still go through
// RPC; this route exists for bytes that must arrive intact.

import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, sep, extname } from "node:path";
import { readFile } from "node:fs/promises";

const PREFIX = "/repo-file/";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function repoFileMime(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// Resolve a /repo-file/ URL to an absolute path under `root`, or null if the
// url isn't under the prefix, is empty, or escapes the root via traversal.
export function resolveRepoFile(root: string, url: string): string | null {
  const path = url.split("?")[0];
  if (!path.startsWith(PREFIX)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(path.slice(PREFIX.length));
  } catch {
    return null; // malformed percent-encoding
  }
  if (!rel) return null;
  const full = join(root, rel);
  const back = relative(root, full);
  if (back === "" || back.startsWith("..") || back.startsWith(sep + "..")) return null;
  return full;
}

// Serve a repo file as raw bytes. Returns true if it handled the request (the
// url was under /repo-file/), false to let the caller fall through.
export async function handleRepoFileRequest(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.split("?")[0].startsWith(PREFIX)) return false;
  const full = resolveRepoFile(root, url);
  if (!full) {
    res.writeHead(403).end("forbidden");
    return true;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      "content-type": repoFileMime(full),
      "cache-control": "no-cache, must-revalidate",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
  return true;
}
