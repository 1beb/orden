import { runAdapterContract } from "../src/testing/adapterContract";
import { makeFakeDriver, makeFakeAdapter } from "./helpers/fakeDriver";

// Self-test: prove the reusable contract suite goes green against the in-repo
// fake adapter before real adapters (Tasks 8/9) depend on it.
runAdapterContract("fake", () => {
  const driver = makeFakeDriver();
  const adapter = makeFakeAdapter("claude", driver);
  return {
    adapter,
    emitTurn() {
      driver.push({ kind: "text", messageId: "m1", text: "Hello" });
      driver.push({ kind: "tool", messageId: "m1", toolId: "t1", name: "Write", input: { path: "x" } });
      driver.push({ kind: "tool-result", toolId: "t1", output: "ok", ok: true });
      driver.push({ kind: "turn-end" });
    },
    emitPermission() {
      return driver.firePermission({ toolName: "Write", input: { path: "x" }, title: "Write x?" });
    },
  };
});
