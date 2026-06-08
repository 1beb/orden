import { describe, it, expectTypeOf } from "vitest";
import type { OrdenAnnotation } from "../src/wadm";

describe("OrdenAnnotation orden:shot", () => {
  it("accepts an optional screenshot asset path", () => {
    expectTypeOf<OrdenAnnotation["orden:shot"]>().toEqualTypeOf<string | undefined>();
  });
});
