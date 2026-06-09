// esbuild bundler for the orden clipper MV3 extension.
//
// Bundles each TS entrypoint to dist/ as ESM and copies the static assets
// (manifest + html). Pass --watch to rebuild on change.
//
//   node build.mjs           # one-shot build
//   node build.mjs --watch   # watch mode

import { build, context } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(root, "src");
const distDir = resolve(root, "dist");
const watch = process.argv.includes("--watch");

const entryPoints = [
  resolve(srcDir, "sw.ts"),
  resolve(srcDir, "content.ts"),
  resolve(srcDir, "offscreen.ts"),
  resolve(srcDir, "options.ts"),
];

/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
  entryPoints,
  outdir: distDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

const staticAssets = [
  [resolve(root, "manifest.json"), resolve(distDir, "manifest.json")],
  [resolve(srcDir, "offscreen.html"), resolve(distDir, "offscreen.html")],
  [resolve(srcDir, "options.html"), resolve(distDir, "options.html")],
];

async function copyStatic() {
  await mkdir(distDir, { recursive: true });
  for (const [from, to] of staticAssets) {
    await cp(from, to);
  }
}

if (watch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  await copyStatic();
  console.log("[orden-clipper] watching for changes…");
} else {
  await build(buildOptions);
  await copyStatic();
  console.log("[orden-clipper] build complete → dist/");
}
