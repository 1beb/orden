import { createHash } from "node:crypto";

/** Stable sha256 hex of a snapshot's bytes — pins the durable artifact. */
export function contentHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
