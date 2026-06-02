import { describe, it, expect } from "vitest";
import { parseClaudeTranscript } from "../../src/chat/claudeTranscript";

// One JSONL line per entry, shaped like a real ~/.claude/projects/<cwd>/<id>.jsonl.
const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");

describe("parseClaudeTranscript", () => {
  it("maps a user prompt + assistant text/tool + tool_result into ordered messages", () => {
    const raw = jsonl(
      { type: "ai-title", aiTitle: "ignored", sessionId: "s" }, // non-message line skipped
      { type: "user", uuid: "u1", message: { role: "user", content: "list the files" } },
      {
        type: "assistant",
        message: {
          id: "a1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "skip me" },
            { type: "text", text: "Listing." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "a.ts\nb.ts" }],
        },
      },
    );

    const msgs = parseClaudeTranscript(raw);
    expect(msgs).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "list the files" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Listing." },
          { type: "tool", toolId: "t1", name: "Bash", input: { command: "ls" }, state: "done", output: "a.ts\nb.ts" },
        ],
      },
    ]);
    // The tool_result entry does NOT add a user bubble — it only flips the tool part.
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("marks a failed tool_result as error and stringifies array content", () => {
    const raw = jsonl(
      {
        type: "assistant",
        message: { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "boom" }] },
          ],
        },
      },
    );
    const tool = parseClaudeTranscript(raw)[0].parts[0];
    expect(tool).toMatchObject({ type: "tool", state: "error", output: "boom" });
  });

  it("skips claude's synthetic user entries (command plumbing, caveats)", () => {
    const raw = jsonl(
      { type: "user", message: { role: "user", content: "<local-command-caveat>Caveat: ...</local-command-caveat>" } },
      { type: "user", message: { role: "user", content: "<command-name>/commit</command-name>" } },
      { type: "user", uuid: "u1", message: { role: "user", content: "actually do the thing" } },
    );
    const msgs = parseClaudeTranscript(raw);
    expect(msgs).toEqual([{ id: "u1", role: "user", parts: [{ type: "text", text: "actually do the thing" }] }]);
  });

  it("skips subagent sidechains and malformed lines", () => {
    const raw = [
      "{ not json",
      JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } }),
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "real prompt" } }),
    ].join("\n");
    const msgs = parseClaudeTranscript(raw);
    expect(msgs).toEqual([{ id: "u1", role: "user", parts: [{ type: "text", text: "real prompt" }] }]);
  });
});
