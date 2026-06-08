// Browser-bundle safety proof for the anchoring engine.
//
// The orden browser-clipper MV3 content script imports the anchoring engine from
// @orden/annotation-core (createAnchor / resolveAnchor, plus the block-id stamping
// helpers assignBlockIds / computeBlockId / BLOCK_ID_ATTR, and the offset helpers).
// esbuild bundles the content script for the browser, where `node:*` builtins
// cannot be resolved.
//
// DECISION (Task 8): the BARREL `@orden/annotation-core` (src/index.ts) is the
// content-script entry. The whole package is browser-safe — every file uses only
// DOM / Web APIs (document, Range, Node, Element, TextEncoder, crypto.subtle).
// There is NO `node:*` import anywhere in the package, including on the barrel's
// export path (hash.ts uses Web Crypto's crypto.subtle, NOT node:crypto). So no
// separate lightweight anchoring build and no narrow src/browser.ts re-export is
// needed: the content script imports directly from the package root.
//
// This test PROVES that by bundling the anchoring surface with esbuild for the
// browser and asserting (a) zero build errors and (b) no `node:` specifier in the
// output. It FAILS the day someone adds a `node:crypto` (or any node:*) import onto
// this import path, which would silently break the content-script bundle.
//
// esbuild is not a direct dependency of this package; it is resolved transitively
// via vitest -> vite -> esbuild (no hardcoded pnpm path), keeping the lockfile
// untouched while still exercising the real bundler the extension build uses.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

// Minimal structural typing for the slice of esbuild's API this test uses.
// esbuild is NOT a dependency of this package (it's resolved transitively via
// vitest -> vite below), so we don't import its types — we describe them.
interface EsbuildBuildResult {
  errors: unknown[];
  warnings: unknown[];
  outputFiles?: Array<{ text: string }>;
}
type EsbuildBuild = (opts: Record<string, unknown>) => Promise<EsbuildBuildResult>;

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
// The barrel the content script imports from. Resolving against src/index.ts is
// equivalent to importing "@orden/annotation-core" (package.json "main").
const barrel = resolve(pkgRoot, "src/index.ts");

// Resolve esbuild through the toolchain already installed for the test runner
// (vitest -> vite -> esbuild) so we don't add a dependency or pin a store hash.
async function loadEsbuild(): Promise<{ build: EsbuildBuild }> {
  // vite is nested under vitest's deps, so hop vitest -> vite -> esbuild.
  const req = createRequire(`${pkgRoot}/package.json`);
  const vitestEntry = req.resolve("vitest");
  const vitestReq = createRequire(vitestEntry);
  const viteEntry = vitestReq.resolve("vite");
  const viteReq = createRequire(viteEntry);
  const esbuildEntry = viteReq.resolve("esbuild");
  return import(esbuildEntry) as Promise<{ build: EsbuildBuild }>;
}

describe("annotation-core is browser-bundle safe for the content script", () => {
  it("bundles the anchoring surface for platform:browser with no node:* builtins", async () => {
    const { build } = await loadEsbuild();

    // The exact public surface the MV3 content script needs for anchoring.
    const entryContents = `
      import {
        createAnchor,
        resolveAnchor,
        assignBlockIds,
        computeBlockId,
        BLOCK_ID_ATTR,
        rangeFromOffsets,
        offsetsFromRange,
      } from ${JSON.stringify(barrel)};
      // Reference every import so tree-shaking can't drop a node-tainted path.
      export const surface = {
        createAnchor,
        resolveAnchor,
        assignBlockIds,
        computeBlockId,
        BLOCK_ID_ATTR,
        rangeFromOffsets,
        offsetsFromRange,
      };
    `;

    const result = await build({
      stdin: {
        contents: entryContents,
        resolveDir: pkgRoot,
        sourcefile: "content-script-entry.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      // Deliberately externalize NOTHING. If any node:* builtin were on the import
      // path, esbuild (platform:browser) would error trying to bundle it.
      external: [],
      logLevel: "silent",
    });

    expect(result.errors).toEqual([]);

    const out = result.outputFiles?.[0]?.text ?? "";
    expect(out.length).toBeGreaterThan(0);
    // No node:* specifier survived into the browser bundle.
    expect(out).not.toMatch(/(["'`])node:[a-z/]+\1/);
    expect(out).not.toContain("require(");

    // Sanity: the anchoring functions actually made it into the bundle.
    expect(out).toContain("createAnchor");
    expect(out).toContain("resolveAnchor");
  });
});
