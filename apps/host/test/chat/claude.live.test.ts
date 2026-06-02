import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEvent } from "@orden/chat-core";
import { makeClaudeAdapter } from "../../src/chat/adapters/claude";

// Live smoke: ONE real turn against the actual claude-agent-sdk. Skipped unless
// ORDEN_LIVE_CLAUDE is set, so normal `pnpm test` runs never spawn a process.
describe.skipIf(!process.env.ORDEN_LIVE_CLAUDE)("claude adapter (live)", () => {
  it(
    "streams at least one text event for a trivial prompt",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "orden-live-claude-"));
      const adapter = makeClaudeAdapter();
      const driver = adapter.open({ cwd });
      // Auto-allow any tool the model might reach for (it shouldn't for "say hi").
      driver.onPermission(async () => ({ allow: true }));

      const events: DriverEvent[] = [];
      await driver.send("say hi");
      try {
        for await (const ev of driver.events) {
          events.push(ev);
          if (ev.kind === "turn-end") break;
        }
      } finally {
        await driver.close();
      }

      expect(events.some((e) => e.kind === "text")).toBe(true);
    },
    120_000,
  );
});
