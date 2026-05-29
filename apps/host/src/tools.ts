// MCP tool implementations over the Host. Kept transport-agnostic and pure of
// the MCP SDK so they're directly testable; mcp.ts wraps them with schemas.
// Pages are the natural agent-editable surface (vault ns "pages"); vault_* give
// raw access to any namespace.

import type { Host } from "@orden/host-api";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  // MCP's CallToolResult carries an index signature; mirror it so these results
  // satisfy registerTool's expected return type.
  [key: string]: unknown;
}

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

export async function pageList(host: Host): Promise<ToolResult> {
  const names = await host.vault.list("pages");
  return text(names.length ? names.sort().join("\n") : "(no pages)");
}

export async function pageRead(host: Host, name: string): Promise<ToolResult> {
  const md = await host.vault.get<string>("pages", name);
  return text(md ?? `(page not found: ${name})`);
}

export async function pageWrite(host: Host, name: string, markdown: string): Promise<ToolResult> {
  await host.vault.set("pages", name, markdown);
  return text(`wrote page "${name}"`);
}

export async function vaultGet(host: Host, ns: string, key: string): Promise<ToolResult> {
  const v = await host.vault.get(ns, key);
  return text(v === null ? `(not found: ${ns}/${key})` : JSON.stringify(v));
}

export async function vaultSet(
  host: Host,
  ns: string,
  key: string,
  json: string,
): Promise<ToolResult> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = json; // not JSON — store the raw string
  }
  await host.vault.set(ns, key, value);
  return text(`set ${ns}/${key}`);
}

export async function vaultList(host: Host, ns: string): Promise<ToolResult> {
  const keys = await host.vault.list(ns);
  return text(keys.length ? keys.sort().join("\n") : "(empty)");
}
