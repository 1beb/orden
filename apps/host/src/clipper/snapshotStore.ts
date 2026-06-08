import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SnapshotStore {
  /** Store bytes for a contentHash; returns the vault-relative snapshotPath. */
  put(hash: string, ext: string, bytes: string | Buffer): Promise<string>;
  get(snapshotPath: string): Promise<string | null>;
  /** Read raw bytes (binary-safe); null if absent. */
  getBytes(snapshotPath: string): Promise<Buffer | null>;
}

export class DiskSnapshotStore implements SnapshotStore {
  constructor(private readonly vaultRoot: string) {}
  async put(hash: string, ext: string, bytes: string | Buffer): Promise<string> {
    const rel = `snapshots/${hash}.${ext}`;
    const abs = join(this.vaultRoot, rel);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
    return rel;
  }
  async get(snapshotPath: string): Promise<string | null> {
    const abs = join(this.vaultRoot, snapshotPath);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }
  async getBytes(snapshotPath: string): Promise<Buffer | null> {
    const abs = join(this.vaultRoot, snapshotPath);
    return existsSync(abs) ? readFileSync(abs) : null;
  }
}
