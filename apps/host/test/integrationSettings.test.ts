import { describe, it, expect } from "vitest";
import {
  readIntegrationSettings,
  integrationFor,
  type IntegrationSettings,
} from "../src/worktrees";
import { DEFAULT_INTEGRATION_MODE, DEFAULT_INTEGRATION_VERIFY } from "../src/mergeTypes";
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
  it("falls back to the defaults when the settings record is empty", async () => {
    expect(await readIntegrationSettings(fakeVault(null))).toEqual({
      mode: DEFAULT_INTEGRATION_MODE,
      verify: DEFAULT_INTEGRATION_VERIFY,
    });
  });
  it("reads explicit global values", async () => {
    expect(
      await readIntegrationSettings(fakeVault({ integrationMode: "measured", integrationVerify: "make ci" })),
    ).toEqual({ mode: "measured", verify: "make ci" });
  });
  it("ignores a non-mode string and an empty verify", async () => {
    expect(
      await readIntegrationSettings(fakeVault({ integrationMode: "wat", integrationVerify: "   " })),
    ).toEqual({ mode: DEFAULT_INTEGRATION_MODE, verify: DEFAULT_INTEGRATION_VERIFY });
  });
});

describe("integrationFor", () => {
  const global: IntegrationSettings = { mode: "fast", verify: "pnpm -r test" };
  it("inherits the global when the project sets no override", async () => {
    expect(integrationFor(global, project({}))).toEqual(global);
  });
  it("lets the project mode override the global", async () => {
    expect(integrationFor(global, project({ integrationMode: "measured" })).mode).toBe("measured");
  });
  it("lets the project verify override the global, ignoring blank", async () => {
    expect(integrationFor(global, project({ integrationVerify: "make test" })).verify).toBe("make test");
    expect(integrationFor(global, project({ integrationVerify: "  " })).verify).toBe(global.verify);
  });
});
