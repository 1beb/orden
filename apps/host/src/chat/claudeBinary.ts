import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Detect whether the running host is on musl libc (Alpine et al.) rather than
 * glibc. Node exposes `glibcVersionRuntime` in its process report on glibc
 * systems and omits it on musl, which is the cheapest reliable signal we have
 * without pulling in a dependency.
 */
function isMuslLibc(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    // Detection failed — assume glibc, the common case.
    return false;
  }
}

/**
 * Resolve the bundled `claude` native binary the SDK should spawn.
 *
 * The SDK's own resolver tries the musl Linux variant *before* the glibc one
 * and returns the first that resolves — it does no libc detection, assuming the
 * package manager installed only the matching optional dep. pnpm installs BOTH
 * platform packages, so on a glibc host the musl binary (listed first) wins and
 * then fails to exec (`/lib/ld-musl-*` is absent). We pick the correct variant
 * ourselves and feed it to `Options.pathToClaudeCodeExecutable`.
 *
 * Resolution is anchored at the SDK package so the platform optional-deps are
 * visible regardless of where this module sits in the tree. Returns null when
 * no bundled binary is found (unbundled platform / missing dep), letting the
 * SDK fall back to its own resolution.
 */
export function resolveClaudeBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const exe = platform === "win32" ? "claude.exe" : "claude";

  const candidates =
    platform === "linux"
      ? isMuslLibc()
        ? [`linux-${arch}-musl`, `linux-${arch}`]
        : [`linux-${arch}`, `linux-${arch}-musl`]
      : [`${platform}-${arch}`];

  let resolve: NodeJS.Require["resolve"];
  try {
    resolve = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk")).resolve;
  } catch {
    resolve = require.resolve;
  }

  for (const suffix of candidates) {
    try {
      return resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/${exe}`);
    } catch {
      // Variant not installed — try the next candidate.
    }
  }
  return null;
}
