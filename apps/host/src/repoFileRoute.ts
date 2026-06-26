// GET /repo-file/<projectId>/<repo-relative-path> → raw file bytes. The web app's
// image viewer points <img src> here, because the RPC files.read() is utf8-only
// and would corrupt binary content. Text files (e.g. HTML source) still go
// through RPC; this route exists for bytes that must arrive intact. The first
// path segment selects the project whose root the rest is resolved under.

import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, sep, extname } from "node:path";
import { readFile } from "node:fs/promises";
import type { ProjectRootResolver } from "./projectRoots";

const PREFIX = "/repo-file/";

// Rendered HTML (Quarto/Pandoc) pulls its theme via relative <link>/<script>/font
// refs, which now flow through this route. Browsers REFUSE a stylesheet served as
// application/octet-stream in standards mode (strict MIME), so css/js/fonts need
// their real content-type or the page renders unstyled — the whole point of the fix.
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

export function repoFileMime(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// Resolve a /repo-file/<projectId>/<rel> URL to an absolute path, or null if the
// url isn't under the prefix, lacks a projectId/rel, names an unknown project, or
// escapes that project's root via traversal. The first path segment is the
// projectId; the rest is the repo-relative path, each decoded separately.
export async function resolveRepoFile(
  resolve: ProjectRootResolver,
  url: string,
): Promise<string | null> {
  const path = url.split("?")[0];
  if (!path.startsWith(PREFIX)) return null;
  const remainder = path.slice(PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash < 0) return null; // need both a projectId segment and a rel path
  let projectId: string;
  let rel: string;
  try {
    projectId = decodeURIComponent(remainder.slice(0, slash));
    rel = decodeURIComponent(remainder.slice(slash + 1));
  } catch {
    return null; // malformed percent-encoding
  }
  if (!projectId || !rel) return null;
  let root: string | undefined;
  try {
    root = await resolve(projectId);
  } catch {
    return null; // resolver threw (e.g. corrupt projects record) → deny, don't hang
  }
  if (!root) return null;
  const full = join(root, rel);
  // An absolute-looking rel (e.g. a decoded leading slash) is intentionally
  // treated as root-relative: join(root, "/x") yields root/x — contained, not an
  // escape — so the silent rewrite below is safe, not a traversal hole.
  const back = relative(root, full);
  if (back === "" || back.startsWith("..") || back.startsWith(sep + "..")) return null;
  return full;
}

// Serve a repo file as raw bytes. Returns true if it handled the request (the
// url was under /repo-file/), false to let the caller fall through.
export async function handleRepoFileRequest(
  resolve: ProjectRootResolver,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.split("?")[0].startsWith(PREFIX)) return false;
  const full = await resolveRepoFile(resolve, url);
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
