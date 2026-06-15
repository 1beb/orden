import { describe, it, expect } from "vitest";
import {
  readIntegrationSettings,
  integrationFor,
  type IntegrationSettings,
} from "../src/worktrees";
import {
  DEFAULT_INTEGRATION_MODE,
  DEFAULT_INTEGRATION_VERIFY,
  DEFAULT_INTEGRATION_REBUILD,
} from "../src/mergeTypes";
import type { Project, VaultStore } from "@orden/host-api";

function fakeVault(app: Record<string, unknown> | null): VaultStore {
  return {
    get: async (ns: string, key: string) => (ns === "settings" && key === "app" ? app : null),
  } as unknown as VaultStore;
}

const project = (over: Partial<Project>): Project => ({
  id: "p1",
  name: "p",
  source: { kind: "local", path: "/repo" },
  ...over,
});

describe("readIntegrationSettings", () => {
  it("falls back to the (toolchain-agnostic, empty-command) defaults when unset", async () => {
    expect(await readIntegrationSettings(fakeVault(null))).toEqual({
      mode: DEFAULT_INTEGRATION_MODE,
      verify: DEFAULT_INTEGRATION_VERIFY,
      rebuild: DEFAULT_INTEGRATION_REBUILD,
    });
    expect(DEFAULT_INTEGRATION_VERIFY).toBe(""); // no baked-in pnpm/TS command
    expect(DEFAULT_INTEGRATION_REBUILD).toBe("");
  });
  it("reads explicit global commands for any toolchain", async () => {
    expect(
      await readIntegrationSettings(
        fakeVault({ integrationMode: "measured", integrationVerify: "pytest -q", integrationRebuild: "make dist" }),
      ),
    ).toEqual({ mode: "measured", verify: "pytest -q", rebuild: "make dist" });
  });
});

describe("integrationFor", () => {
  const global: IntegrationSettings = { mode: "fast", verify: "cargo test", rebuild: "" };
  it("inherits the global when the project sets no override", async () => {
    expect(integrationFor(global, project({}))).toEqual(global);
  });
  it("lets the project mode override the global", async () => {
    expect(integrationFor(global, project({ integrationMode: "measured" })).mode).toBe("measured");
  });
  it("lets the project commands override the global (empty string is a valid override)", async () => {
    expect(integrationFor(global, project({ integrationVerify: "go test ./..." })).verify).toBe("go test ./...");
    expect(integrationFor(global, project({ integrationVerify: "" })).verify).toBe(""); // explicit "no gate"
    expect(integrationFor(global, project({ integrationRebuild: "npm run build" })).rebuild).toBe("npm run build");
  });
});
