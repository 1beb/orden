import { describe, test, expect } from "vitest";
import { encodeCwd, readTranscriptTitle } from "../src/transcriptTitle";

describe("transcriptTitle", () => {
  test("encodeCwd maps an absolute path to Claude's project dir name", () => {
    expect(encodeCwd("/home/b/projects/orden")).toBe("-home-b-projects-orden");
    // dots are encoded too (e.g. dotfiles / versioned dirs)
    expect(encodeCwd("/home/b/.config/app")).toBe("-home-b--config-app");
  });

  test("readTranscriptTitle returns null when no transcript exists (never throws)", () => {
    expect(readTranscriptTitle("/no/such/cwd", "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
