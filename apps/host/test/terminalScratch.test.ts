import { describe, test, expect } from "vitest";
import { isScratchReq } from "../src/terminal";

describe("isScratchReq", () => {
  test("scratch=1 marks a scratch request", () => {
    expect(isScratchReq(new URL("http://x/term?scratch=1"))).toBe(true);
  });

  test("session=scratch marks a scratch request", () => {
    expect(isScratchReq(new URL("http://x/term?session=scratch"))).toBe(true);
  });

  test("a real session id is not a scratch request", () => {
    expect(isScratchReq(new URL("http://x/term?session=s1"))).toBe(false);
  });

  test("no session/scratch param is not a scratch request", () => {
    expect(isScratchReq(new URL("http://x/term?cols=80"))).toBe(false);
  });
});
