import { describe, it, expect } from "vitest";
import { AdapterRegistry, defaultRegistry } from "../src/registry";
import type { HarnessAdapter, HarnessDriver, ModelOption } from "../src/index";

function fakeAdapter(harness: HarnessAdapter["harness"]): HarnessAdapter {
  return {
    harness,
    async listModels(): Promise<ModelOption[]> {
      return [];
    },
    open(): HarnessDriver {
      throw new Error("not used");
    },
  };
}

describe("AdapterRegistry", () => {
  it("registers and gets an adapter by harness", () => {
    const reg = new AdapterRegistry();
    const a = fakeAdapter("claude");
    reg.register(a);
    expect(reg.get("claude")).toBe(a);
  });

  it("throws a clear error when no adapter is registered", () => {
    const reg = new AdapterRegistry();
    expect(() => reg.get("opencode")).toThrowError(/opencode/);
  });

  it("exposes a module-level default instance distinct from fresh ones", () => {
    expect(defaultRegistry).toBeInstanceOf(AdapterRegistry);
    expect(new AdapterRegistry()).not.toBe(defaultRegistry);
  });
});
