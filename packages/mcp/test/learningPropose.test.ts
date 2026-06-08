import { describe, it, expect } from "vitest";
import type { Host } from "@orden/host-api";
import { learningPropose } from "../src/tools";
import { getLearning } from "../src/learnings";
import { fakeVault } from "./fakeVault";

function resultText(res: { content: Array<{ type: string; text: string }> }): string {
  return res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Minimal Host: a real fake vault + an injectable files.read.
function fakeHost(read: (projectId: string, path: string) => Promise<string>): Host {
  return {
    vault: fakeVault(),
    files: { read },
  } as unknown as Host;
}

const binding = { cardId: "item_1", projectId: "repo", sessionId: "sess_1" };
const input = {
  type: "readme" as const,
  title: "  Document the new flag  ",
  recap: "  We learned X during the session.  ",
  path: "README.md",
  content: "# New content\n",
};

describe("learningPropose tool", () => {
  it("records an edit learning when the target file exists", async () => {
    const host = fakeHost(async () => "old content");
    const res = await learningPropose(host, binding, input, 1717, "learn_abc");

    const l = await getLearning(host.vault, "learn_abc");
    expect(l).not.toBeNull();
    expect(l).toMatchObject({
      id: "learn_abc",
      cardId: "item_1",
      sessionId: "sess_1",
      projectId: "repo",
      type: "readme",
      title: "Document the new flag",
      recap: "We learned X during the session.",
      targetPath: "README.md",
      op: "edit",
      proposedContent: "# New content\n",
      baseContent: "old content",
      status: "pending",
      createdAt: 1717,
    });

    const t = resultText(res);
    expect(t).toContain("learn_abc");
    expect(t).toContain("edit");
  });

  it("records a create learning when the target file is missing (ENOENT)", async () => {
    const host = fakeHost(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const res = await learningPropose(host, binding, input, 42, "learn_xyz");

    const l = await getLearning(host.vault, "learn_xyz");
    expect(l).not.toBeNull();
    expect(l?.op).toBe("create");
    expect(l?.baseContent).toBeUndefined();
    expect(l?.status).toBe("pending");
    expect(l?.createdAt).toBe(42);

    const t = resultText(res);
    expect(t).toContain("learn_xyz");
    expect(t).toContain("create");
  });

  it("propagates a non-ENOENT read error and writes nothing", async () => {
    const host = fakeHost(async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    await expect(
      learningPropose(host, binding, input, 99, "learn_err"),
    ).rejects.toThrow("denied");

    expect(await getLearning(host.vault, "learn_err")).toBeNull();
    expect(await host.vault.list("learnings")).toHaveLength(0);
  });
});
