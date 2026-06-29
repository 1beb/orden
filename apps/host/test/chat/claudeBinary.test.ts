import { describe, expect, it } from "vitest";
import { resolveClaudeBinary } from "../../src/chat/claudeBinary";

describe("resolveClaudeBinary", () => {
  it("resolves the glibc Linux binary on this (glibc) host", () => {
    const p = resolveClaudeBinary("linux", "x64");
    expect(p).toBeTruthy();
    // Must NOT pick the musl variant, which can't exec on a glibc host.
    expect(p).not.toMatch(/-musl[\\/]/);
    expect(p).toMatch(/claude-agent-sdk-linux-x64[\\/]claude$/);
  });

  it("returns null for a platform that has no bundled package", () => {
    expect(resolveClaudeBinary("sunos" as NodeJS.Platform, "sparc")).toBeNull();
  });
});
