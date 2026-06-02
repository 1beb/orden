import type { Source } from "./wadm";

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Stable, filename-safe key from a source's IDENTITY (not its bytes).
export function sourceHash(source: Source): string {
  const identity = source.kind === "web" ? `web|${source.url}` : `file|${source.vaultPath}`;
  return fnv1a(identity);
}

// Integrity hash of source bytes/text. SHA-256 via Web Crypto (browser + Node 18+).
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
