import { describe, it, expect } from "vitest";
import { fakeVault } from "./fakeVault";
import { pageWrite } from "../src/tools";
import type { Host, VaultStore } from "@orden/host-api";

const hostWith = (vault: VaultStore): Host => ({ vault }) as unknown as Host;

interface PageMeta {
  created: string;
  updated: string;
}

describe("pageWrite", () => {
  it("writes the page body to the pages ns", async () => {
    const v = fakeVault();
    await pageWrite(hostWith(v), "My Notes", "# hi");
    expect(await v.get("pages", "My Notes")).toBe("# hi");
  });

  it("stamps a pagemeta sidecar so the Pages index shows a created/updated date", async () => {
    const v = fakeVault();
    await pageWrite(hostWith(v), "My Notes", "# hi");
    const meta = await v.get<PageMeta>("pagemeta", "My Notes");
    expect(meta).not.toBeNull();
    expect(meta?.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta?.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves the original created timestamp on rewrite, bumping updated", async () => {
    const v = fakeVault();
    await v.set("pagemeta", "My Notes", {
      created: "2020-01-01T00:00:00.000Z",
      updated: "2020-01-01T00:00:00.000Z",
    });
    await pageWrite(hostWith(v), "My Notes", "# changed");
    const meta = await v.get<PageMeta>("pagemeta", "My Notes");
    expect(meta?.created).toBe("2020-01-01T00:00:00.000Z");
    expect(meta?.updated).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("routes a journal-dated page to the journal ns and seeds created from its date", async () => {
    const v = fakeVault();
    await pageWrite(hostWith(v), "2026-06-23", "# day");
    expect(await v.get("journal", "2026-06-23")).toBe("# day");
    const meta = await v.get<PageMeta>("pagemeta", "2026-06-23");
    expect(meta?.created).toBe("2026-06-23T00:00:00");
  });
});
