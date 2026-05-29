import { describe, test, expect, vi } from "vitest";
import type { Host } from "@orden/host-api";
import { selectHost } from "../src/host/selectHost";

const fakeHost = (tag: string) => ({ tag }) as unknown as Host;

describe("selectHost", () => {
  test("with no host url, uses the browser host", async () => {
    const makeBrowser = vi.fn(() => fakeHost("browser"));
    const connectNode = vi.fn(async () => fakeHost("node"));

    const host = await selectHost(undefined, { makeBrowser, connectNode });

    expect((host as unknown as { tag: string }).tag).toBe("browser");
    expect(makeBrowser).toHaveBeenCalledOnce();
    expect(connectNode).not.toHaveBeenCalled();
  });

  test("with an empty host url, still uses the browser host", async () => {
    const makeBrowser = vi.fn(() => fakeHost("browser"));
    const connectNode = vi.fn(async () => fakeHost("node"));

    await selectHost("   ", { makeBrowser, connectNode });

    expect(makeBrowser).toHaveBeenCalledOnce();
    expect(connectNode).not.toHaveBeenCalled();
  });

  test("with a host url, connects to the node host at that url", async () => {
    const makeBrowser = vi.fn(() => fakeHost("browser"));
    const connectNode = vi.fn(async () => fakeHost("node"));

    const host = await selectHost("ws://127.0.0.1:4319", { makeBrowser, connectNode });

    expect((host as unknown as { tag: string }).tag).toBe("node");
    expect(connectNode).toHaveBeenCalledWith("ws://127.0.0.1:4319");
    expect(makeBrowser).not.toHaveBeenCalled();
  });
});
