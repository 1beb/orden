import { describe, it, expect } from "vitest";
import {
  createOrdenAnnotation,
  resolveSelectors,
  sourceHash,
  contentHash,
  migrateLegacyDoc,
} from "../src/index";
// Type-only exports can't be asserted at runtime; importing them here makes the
// barrel's type surface a compile target, so a future `export *` collision that
// drops/shadows one of these fails `npm run typecheck`.
import type {
  Source,
  Selector,
  OrdenAnnotation,
  OrdenStatus,
  OrdenAudience,
  OrdenReply,
  RegionSelector,
  AnnotationBundle,
  LegacyDocInput,
} from "../src/index";

describe("public surface", () => {
  it("re-exports the WADM foundation", () => {
    expect(typeof createOrdenAnnotation).toBe("function");
    expect(typeof resolveSelectors).toBe("function");
    expect(typeof sourceHash).toBe("function");
    expect(typeof contentHash).toBe("function");
    expect(typeof migrateLegacyDoc).toBe("function");
  });

  it("re-exports the WADM types (compile-time guard)", () => {
    // The assignments exist only so tsc checks each type resolves through the
    // barrel; the runtime body is a trivial truthiness check.
    const probe: {
      source?: Source;
      selector?: Selector;
      annotation?: OrdenAnnotation;
      status?: OrdenStatus;
      audience?: OrdenAudience;
      reply?: OrdenReply;
      region?: RegionSelector;
      bundle?: AnnotationBundle;
      input?: LegacyDocInput;
    } = {};
    expect(probe).toBeDefined();
  });
});
