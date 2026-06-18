// Minimal ambient types for the built-in node:sqlite module. The repo pins
// @types/node ^20, which predates node:sqlite (added to the types around 22.5).
// This declares only the surface VaultIndex uses. Delete this shim once the repo
// moves @types/node to >=22.5 and gets these types for free.
declare module "node:sqlite" {
  type SqlValue = string | number | bigint | null | Uint8Array;

  export class StatementSync {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
