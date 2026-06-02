import { describe, it, expect } from "vitest";
import type { DriverEvent, HarnessAdapter } from "../index";

// The contract a caller supplies so the reusable suite can drive their adapter.
export interface AdapterContractHarness {
  adapter: HarnessAdapter;
  // Drive the adapter's CURRENTLY-OPEN driver through one happy-path turn that
  // should normalize to: (optional session) → text → tool → tool-result → turn-end.
  emitTurn(): void | Promise<void>;
  // Make the harness ask for ONE tool permission; returns the promise the
  // harness-side is awaiting (so the contract can assert it settles).
  emitPermission(): Promise<{ allow: boolean }>;
  expectedModelsMin?: number; // default 1
}

// Settle pending microtasks/timers so a detached pump can drain.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Drain `events` into `out` in the background; returns a stop() that ends the loop.
function collect(
  events: AsyncIterable<DriverEvent>,
  out: DriverEvent[],
): { stop: () => void } {
  let stopped = false;
  void (async () => {
    for await (const ev of events) {
      if (stopped) break;
      out.push(ev);
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}

// Poll until predicate holds or a small timeout elapses; throws with `msg` on timeout.
async function waitFor(
  pred: () => boolean,
  msg: string,
  { tries = 100 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`adapter contract timed out waiting for: ${msg}`);
}

// Run the reusable HarnessAdapter contract against a caller-provided harness.
// Importable by other packages via "@orden/chat-core/testing".
export function runAdapterContract(label: string, make: () => AdapterContractHarness): void {
  describe(`adapter contract: ${label}`, () => {
    it("lists models", async () => {
      const { adapter, expectedModelsMin } = make();
      const models = await adapter.listModels();
      const min = expectedModelsMin ?? 1;
      expect(models.length).toBeGreaterThanOrEqual(min);
      for (const m of models) {
        expect(typeof m.id).toBe("string");
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.label).toBe("string");
        expect(m.label.length).toBeGreaterThan(0);
      }
    });

    it("streams a normalized turn", async () => {
      const h = make();
      const driver = h.adapter.open({ cwd: "/contract" });
      const events: DriverEvent[] = [];
      const sink = collect(driver.events, events);
      try {
        await h.emitTurn();
        await waitFor(
          () => events.some((e) => e.kind === "turn-end"),
          "a turn-end event",
        );

        const text = events.find((e) => e.kind === "text");
        const tool = events.find((e) => e.kind === "tool");
        const toolResult = events.find((e) => e.kind === "tool-result");
        const turnEnd = events.find((e) => e.kind === "turn-end");

        expect(text, "expected a text event").toBeTruthy();
        expect(tool, "expected a tool event").toBeTruthy();
        expect(toolResult, "expected a tool-result event").toBeTruthy();
        expect(turnEnd, "expected a turn-end event").toBeTruthy();

        // Assert ordering: text < tool < tool-result < turn-end.
        const iText = events.indexOf(text!);
        const iTool = events.indexOf(tool!);
        const iResult = events.indexOf(toolResult!);
        const iEnd = events.indexOf(turnEnd!);
        expect(iText).toBeLessThan(iTool);
        expect(iTool).toBeLessThan(iResult);
        expect(iResult).toBeLessThan(iEnd);

        // tool-result must reference the same toolId as the tool.
        if (tool!.kind === "tool" && toolResult!.kind === "tool-result") {
          expect(toolResult!.toolId).toBe(tool!.toolId);
        }
      } finally {
        sink.stop();
      }
    });

    it("round-trips a permission", async () => {
      const h = make();
      const driver = h.adapter.open({ cwd: "/contract" });
      let seen: { toolName: string; input: unknown; title: string } | null = null;
      driver.onPermission(async (req) => {
        seen = req;
        return { allow: true };
      });

      const settled = h.emitPermission();
      const result = await settled;

      expect(seen, "onPermission cb was not invoked").toBeTruthy();
      expect(typeof seen!.toolName).toBe("string");
      expect(seen!.toolName.length).toBeGreaterThan(0);
      expect("input" in seen!).toBe(true);
      expect(typeof seen!.title).toBe("string");
      expect(result).toEqual({ allow: true });
    });

    it("accepts control calls + closes", async () => {
      const h = make();
      const driver = h.adapter.open({ cwd: "/contract" });
      await driver.send("/noop");
      await driver.setModel("m");
      const cmds = await driver.listCommands();
      expect(Array.isArray(cmds)).toBe(true);
      await driver.close();
    });
  });
}
