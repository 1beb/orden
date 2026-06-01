import { describe, test, expect } from "vitest";
import {
  encodeCwd,
  readTranscriptTitle,
  readTranscriptSummary,
  readUserPrompt,
  firstUserPrompt,
} from "../src/transcriptTitle";

const userLine = (content: unknown): string =>
  JSON.stringify({ type: "user", message: { role: "user", content } });

describe("transcriptTitle", () => {
  test("encodeCwd maps an absolute path to Claude's project dir name", () => {
    expect(encodeCwd("/home/b/projects/orden")).toBe("-home-b-projects-orden");
    // dots are encoded too (e.g. dotfiles / versioned dirs)
    expect(encodeCwd("/home/b/.config/app")).toBe("-home-b--config-app");
  });

  test("readTranscriptTitle returns null when no transcript exists (never throws)", () => {
    expect(readTranscriptTitle("/no/such/cwd", "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("readTranscriptSummary returns null when no transcript exists (never throws)", () => {
    expect(readTranscriptSummary("/no/such/cwd", "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("readUserPrompt returns null when no transcript exists (never throws)", () => {
    expect(readUserPrompt("/no/such/cwd", "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  describe("firstUserPrompt", () => {
    test("returns the first human turn (string content)", () => {
      const raw = [userLine("Fix the flaky test"), userLine("second turn")].join("\n");
      expect(firstUserPrompt(raw)).toBe("Fix the flaky test");
    });

    test("joins array text parts and collapses whitespace", () => {
      const raw = userLine([{ type: "text", text: "Why is\n  this   slow" }]);
      expect(firstUserPrompt(raw)).toBe("Why is this slow");
    });

    test("skips tool-result / command envelopes (text starting with '<')", () => {
      const raw = [userLine("<command-name>/foo</command-name>"), userLine("the real ask")].join("\n");
      expect(firstUserPrompt(raw)).toBe("the real ask");
    });

    test("returns null when there is no real human turn", () => {
      const raw = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } });
      expect(firstUserPrompt(raw)).toBeNull();
    });

    test("caps very long prompts", () => {
      const long = "x".repeat(500);
      const out = firstUserPrompt(userLine(long));
      expect(out).not.toBeNull();
      expect(out!.length).toBeLessThanOrEqual(200);
      expect(out!.endsWith("…")).toBe(true);
    });
  });
});
