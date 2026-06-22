import { describe, it, expect } from "vitest";
import { sessionLaunchEnv } from "./terminal";

describe("sessionLaunchEnv ORDEN_OPENCODE_ROOT seeding", () => {
  it("seeds the root id for an opencode session being resumed", () => {
    const r = sessionLaunchEnv(
      { agent: "opencode", conversationId: "ses_root123" },
      "sess_1",
    );
    expect(r.env.ORDEN_OPENCODE_ROOT).toBe("ses_root123");
    expect(r.args).toContain("ORDEN_OPENCODE_ROOT=ses_root123");
    expect(r.cmdPrefix).toContain("ORDEN_OPENCODE_ROOT=");
  });

  it("omits the root id on first launch (no conversationId yet)", () => {
    const r = sessionLaunchEnv({ agent: "opencode" }, "sess_1");
    expect(r.env.ORDEN_OPENCODE_ROOT).toBeUndefined();
    expect(r.cmdPrefix).not.toContain("ORDEN_OPENCODE_ROOT");
  });

  it("does not add the var for claude sessions", () => {
    const r = sessionLaunchEnv({ agent: "claude", conversationId: "abc" }, "sess_1");
    expect(r.env.ORDEN_OPENCODE_ROOT).toBeUndefined();
  });
});
