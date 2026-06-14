import { describe, expect, it, vi } from "vitest";
import { createVaultChangeRouter } from "../src/vaultChangeRouter";

describe("vault-change router", () => {
  it("dispatches a change to its namespace handler with key + projectId", async () => {
    const router = createVaultChangeRouter();
    const cards = vi.fn();
    const files = vi.fn();
    router.register("cards", cards);
    router.register("files", files);

    await router.dispatch("files", "docs/readme.md", "proj1");

    expect(files).toHaveBeenCalledWith("docs/readme.md", "proj1");
    expect(cards).not.toHaveBeenCalled();
  });

  it("ignores namespaces without a handler (e.g. chat:<id>)", async () => {
    const router = createVaultChangeRouter();
    await expect(router.dispatch("chat:abc", "k")).resolves.toBeUndefined();
  });

  it("awaits async handlers", async () => {
    const router = createVaultChangeRouter();
    let settled = false;
    router.register("pages", async () => {
      await Promise.resolve();
      settled = true;
    });
    await router.dispatch("pages", "Home");
    expect(settled).toBe(true);
  });

  it("rejects a second handler for the same namespace", () => {
    const router = createVaultChangeRouter();
    router.register("sessions", () => {});
    expect(() => router.register("sessions", () => {})).toThrow(/already registered/);
  });
});
