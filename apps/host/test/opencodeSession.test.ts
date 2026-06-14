import { describe, test, expect } from "vitest";
import {
  discoverOpencodeSession,
  existingOpencodeSessions,
  readOpencodeTitle,
  opencodeSessionInCwd,
} from "../src/opencodeSession";

// These call the real `opencode` CLI under the hood. The contract we assert is the
// safety net: every helper returns a benign empty/null value (never throws) for a
// cwd with no opencode sessions and for an unknown session id — regardless of
// whether the opencode binary is even installed in the test environment.
describe("opencodeSession", () => {
  const cwd = "/no/such/orden/cwd/for/opencode";

  test("existingOpencodeSessions returns an empty set for an unknown cwd", async () => {
    const set = await existingOpencodeSessions(cwd);
    expect(set instanceof Set).toBe(true);
    expect(set.size).toBe(0);
  });

  test("discoverOpencodeSession returns null when no session matches the cwd", async () => {
    expect(await discoverOpencodeSession(cwd)).toBeNull();
  });

  test("readOpencodeTitle returns null for an unknown session id (never throws)", async () => {
    expect(await readOpencodeTitle(cwd, "ses_does_not_exist")).toBeNull();
  });

  test("opencodeSessionInCwd returns false for an unknown session id (never throws)", async () => {
    expect(await opencodeSessionInCwd(cwd, "ses_does_not_exist")).toBe(false);
  });
});
