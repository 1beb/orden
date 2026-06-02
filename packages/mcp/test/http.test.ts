import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import type { Host } from "@orden/host-api";
import { handleMcpRequest, parseSessionBinding } from "../src/http";

// Minimal req/res doubles. The stale-session path never touches the Host (the
// server is only built inside the initialize branch), so an empty host is fine.
function mockReq(opts: {
  method: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url?: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.headers ?? {};
  // Emit the JSON body on the next tick so readJsonBody's listeners attach first.
  queueMicrotask(() => {
    if (opts.body !== undefined) req.emit("data", Buffer.from(JSON.stringify(opts.body)));
    req.emit("end");
  });
  return req;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: "",
    headers: {} as Record<string, unknown>,
    writeHead(code: number, headers?: Record<string, unknown>) {
      this.statusCode = code;
      if (headers) this.headers = headers;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      return this;
    },
  };
  return res;
}

describe("handleMcpRequest stale-session recovery", () => {
  it("answers a non-initialize POST with an unknown session id with 404 (not 400)", async () => {
    // Simulates a long-lived agent whose Mcp-Session-Id predates a host restart:
    // the in-memory transports map is empty, the body is a tool call, not init.
    const req = mockReq({
      method: "POST",
      url: "/mcp/conv-1",
      headers: { "mcp-session-id": "stale-id-from-before-restart" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const res = mockRes();
    await handleMcpRequest({} as Host, req as never, res as never);
    // 404 is the spec's "session terminated" signal that tells the client to
    // re-initialize; 400 leaves it stuck repeating the same failed call.
    expect(res.statusCode).toBe(404);
  });
});

describe("parseSessionBinding", () => {
  it("returns the path id for /mcp/<id>", () => {
    expect(parseSessionBinding({ url: "/mcp/abc-123", headers: {} })).toBe("abc-123");
  });

  it("prefers the x-orden-session header over the path", () => {
    expect(
      parseSessionBinding({ url: "/mcp/abc-123", headers: { "x-orden-session": "hdr" } }),
    ).toBe("hdr");
  });

  it("returns undefined for a bare /mcp", () => {
    expect(parseSessionBinding({ url: "/mcp", headers: {} })).toBeUndefined();
  });

  it("returns undefined when there is no url and no header", () => {
    expect(parseSessionBinding({ headers: {} })).toBeUndefined();
  });

  it("strips a query string from the path id", () => {
    expect(parseSessionBinding({ url: "/mcp/abc?x=1", headers: {} })).toBe("abc");
  });

  it("decodes a percent-encoded path id", () => {
    expect(parseSessionBinding({ url: "/mcp/a%20b", headers: {} })).toBe("a b");
  });
});
