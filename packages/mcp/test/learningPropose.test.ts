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

  it("updates in place when given an existing id (revision)", async () => {
    const host = fakeHost(async () => "fresh base content");
    // Seed an original proposal with a comment + binding to preserve.
    await learningPropose(host, binding, input, 1000, "learn_rev");
    // Simulate a user comment landing on it before the revision.
    const seeded = await getLearning(host.vault, "learn_rev");
    await host.vault.set("learnings", "learn_rev", {
      ...seeded!,
      comments: [{ at: 1500, text: "be more concise" }],
    });

    const revised = {
      type: "adr" as const,
      title: "  Revised title  ",
      recap: "  revised recap  ",
      path: "docs/ADR-1.md",
      content: "# Revised\n",
    };
    const res = await learningPropose(host, binding, revised, 2000, "learn_rev");

    // Exactly one record — updated, not duplicated.
    expect(await host.vault.list("learnings")).toHaveLength(1);
    const l = await getLearning(host.vault, "learn_rev");
    expect(l).toMatchObject({
      id: "learn_rev",
      cardId: "item_1",
      projectId: "repo",
      sessionId: "sess_1",
      createdAt: 1000, // preserved
      type: "adr", // replaced
      title: "Revised title", // replaced + trimmed
      recap: "revised recap", // replaced + trimmed
      targetPath: "docs/ADR-1.md", // replaced
      op: "edit",
      proposedContent: "# Revised\n", // replaced
      baseContent: "fresh base content", // re-derived
      status: "pending", // back to pending for re-review
    });
    // Existing comment preserved.
    expect(l?.comments).toEqual([{ at: 1500, text: "be more concise" }]);

    const t = resultText(res);
    expect(t).toContain("learn_rev");
    expect(t).toContain("revised");
  });

  it("creates a new record when given an unknown id", async () => {
    const host = fakeHost(async () => "base");
    const res = await learningPropose(host, binding, input, 7, "learn_new_id");

    const l = await getLearning(host.vault, "learn_new_id");
    expect(l).not.toBeNull();
    expect(l?.status).toBe("pending");
    expect(l?.createdAt).toBe(7);
    expect(await host.vault.list("learnings")).toHaveLength(1);
    expect(resultText(res)).toContain("learn_new_id");
  });

  it("refuses to modify a learning owned by a different card", async () => {
    const host = fakeHost(async () => "base");
    // A learning owned by card item_1.
    await learningPropose(host, binding, input, 1000, "learn_foreign");
    const before = await getLearning(host.vault, "learn_foreign");

    // A different card's session reuses that id: must NOT overwrite it.
    const otherBinding = { cardId: "item_2", projectId: "repo", sessionId: "sess_2" };
    const res = await learningPropose(host, otherBinding, { ...input, title: "Hijack" }, 2000, "learn_foreign");

    // The original is untouched and no second record was created.
    expect(await getLearning(host.vault, "learn_foreign")).toEqual(before);
    expect(await host.vault.list("learnings")).toHaveLength(1);
    expect(resultText(res)).toContain("different card");
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
