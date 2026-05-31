import { describe, test, expect, afterEach } from "vitest";
import { mcpConfigArg } from "../src/terminal";

const ORIGINAL_PORT = process.env.ORDEN_PORT;
afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.ORDEN_PORT;
  else process.env.ORDEN_PORT = ORIGINAL_PORT;
});

// Parse the JSON back out of the `--mcp-config '<json>'` fragment.
function parseConfig(arg: string): { mcpServers: Record<string, { type: string; url: string }> } {
  const m = arg.match(/^--mcp-config '(.*)'$/s);
  if (!m) throw new Error(`unexpected fragment: ${arg}`);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

describe("mcpConfigArg", () => {
  test("binds an 'orden' http server to the session-scoped /mcp/<convId> path", () => {
    delete process.env.ORDEN_PORT;
    const arg = mcpConfigArg("conv-123");
    expect(arg.startsWith("--mcp-config ")).toBe(true);
    const cfg = parseConfig(arg);
    expect(cfg.mcpServers.orden).toEqual({
      type: "http",
      url: "http://127.0.0.1:4319/mcp/conv-123",
    });
  });

  test("uses ORDEN_PORT when set", () => {
    process.env.ORDEN_PORT = "5555";
    const cfg = parseConfig(mcpConfigArg("abc"));
    expect(cfg.mcpServers.orden.url).toBe("http://127.0.0.1:5555/mcp/abc");
  });
});
