import { describe, it, expect } from "vitest";

describe("environment", () => {
  it("has a DOM", () => {
    const el = document.createElement("div");
    el.textContent = "hello";
    expect(el.textContent).toBe("hello");
  });
});
