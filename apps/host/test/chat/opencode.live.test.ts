import { describe, it, expect } from "vitest";
import type { DriverEvent } from "@orden/chat-core";
import { makeOpencodeAdapter } from "../../src/chat/adapters/opencode";

// Live smoke test against a real opencode binary. Skipped unless an opencode
// install exists on this machine and the gate env is set. Spawns a real server
// via createOpencode(), runs one round-trip, and asserts a turn completes.
const LIVE = process.env.ORDEN_LIVE_OPENCODE === "1";

describe.skipIf(!LIVE)("opencode adapter (live)", () => {
  it(
    "completes one real turn",
    async () => {
      const adapter = makeOpencodeAdapter();

      const models = await adapter.listModels();
      expect(models.length).toBeGreaterThan(0);

      const driver = adapter.open({ cwd: process.cwd(), model: models[0].id });
      driver.onPermission(async () => ({ allow: true }));

      const events: DriverEvent[] = [];
      const done = (async () => {
        for await (const ev of driver.events) {
          events.push(ev);
          if (ev.kind === "turn-end") break;
        }
      })();

      await driver.send("Reply with the single word: pong");
      await done;
      await driver.close();

      expect(events.some((e) => e.kind === "session")).toBe(true);
      expect(events.some((e) => e.kind === "text")).toBe(true);
      expect(events.some((e) => e.kind === "turn-end")).toBe(true);
    },
    60_000,
  );
});
