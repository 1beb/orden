// The orden MCP server: exposes the Host (pages + raw vault) as MCP tools so
// agents (claude/opencode) read/write the same vault the web UI uses. This is
// the agent↔orden bus; it wraps the same NodeHost the ws bus serves.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Host } from "@orden/host-api";
import * as tools from "./tools";

export function createMcpServer(host: Host): McpServer {
  const server = new McpServer({ name: "orden", version: "0.1.0" });

  server.registerTool(
    "page_list",
    { description: "List the names of all orden pages.", inputSchema: {} },
    () => tools.pageList(host),
  );

  server.registerTool(
    "page_read",
    {
      description: "Read an orden page's markdown by name.",
      inputSchema: { name: z.string().describe("Page name") },
    },
    ({ name }) => tools.pageRead(host, name),
  );

  server.registerTool(
    "page_write",
    {
      description: "Create or overwrite an orden page with markdown.",
      inputSchema: {
        name: z.string().describe("Page name"),
        markdown: z.string().describe("Page body in markdown"),
      },
    },
    ({ name, markdown }) => tools.pageWrite(host, name, markdown),
  );

  server.registerTool(
    "vault_get",
    {
      description: "Read a raw value from the orden vault by namespace and key.",
      inputSchema: { ns: z.string(), key: z.string() },
    },
    ({ ns, key }) => tools.vaultGet(host, ns, key),
  );

  server.registerTool(
    "vault_set",
    {
      description: "Write a value into the orden vault. value is a JSON string (or raw text).",
      inputSchema: { ns: z.string(), key: z.string(), value: z.string() },
    },
    ({ ns, key, value }) => tools.vaultSet(host, ns, key, value),
  );

  server.registerTool(
    "vault_list",
    {
      description: "List the keys in an orden vault namespace.",
      inputSchema: { ns: z.string() },
    },
    ({ ns }) => tools.vaultList(host, ns),
  );

  return server;
}
