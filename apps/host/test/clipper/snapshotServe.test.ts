import { describe, test, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSnapshotRequest } from "../../src/clipper/snapshotServe";
import type { SnapshotStore } from "../../src/clipper/snapshotStore";

// Fake IncomingMessage: only method + url are read by the handler.
function fakeReq(url: string, method = "GET"): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

// Fake ServerResponse: records the writeHead status/headers and the end() body.
function fakeRes(): ServerResponse & {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
} {
  const res = {
    status: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    body: undefined as unknown,
    writeHead(code: number, headers?: Record<string, string>) {
      this.status = code;
      this.headers = headers;
      return this;
    },
    end(chunk?: unknown) {
      this.body = chunk;
      return this;
    },
  };
  return res as unknown as ServerResponse & {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

// In-memory SnapshotStore: a Map of vault-relative path → bytes. get() returns the
// utf8 string form, getBytes() the Buffer form. put() unused here.
function fakeStore(entries: Record<string, string | Buffer>): SnapshotStore & {
  getSpy: ReturnType<typeof vi.fn>;
  getBytesSpy: ReturnType<typeof vi.fn>;
} {
  const map = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(entries)) {
    map.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8"));
  }
  const getSpy = vi.fn(async (p: string) => {
    const b = map.get(p);
    return b ? b.toString("utf8") : null;
  });
  const getBytesSpy = vi.fn(async (p: string) => map.get(p) ?? null);
  return {
    put: vi.fn(async () => ""),
    get: getSpy,
    getBytes: getBytesSpy,
    getSpy,
    getBytesSpy,
  } as unknown as SnapshotStore & {
    getSpy: ReturnType<typeof vi.fn>;
    getBytesSpy: ReturnType<typeof vi.fn>;
  };
}

describe("handleSnapshotRequest", () => {
  test("stored .html: 200, text/html content-type, stored body", async () => {
    const html = "<article>frozen</article>";
    const store = fakeStore({ "snapshots/abc.html": html });
    const res = fakeRes();
    await handleSnapshotRequest(store, fakeReq("/snapshot/snapshots/abc.html"), res);
    expect(res.status).toBe(200);
    expect(res.headers?.["content-type"]).toMatch(/^text\/html/);
    expect(res.body).toBe(html);
  });

  test("stored .webp: 200, image/webp content-type, stored bytes", async () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
    const store = fakeStore({ "snapshots/abc-0.webp": bytes });
    const res = fakeRes();
    await handleSnapshotRequest(store, fakeReq("/snapshot/snapshots/abc-0.webp"), res);
    expect(res.status).toBe(200);
    expect(res.headers?.["content-type"]).toBe("image/webp");
    expect(res.body).toEqual(bytes);
  });

  test("path with .. segment: 400, store NOT read", async () => {
    const store = fakeStore({});
    const res = fakeRes();
    await handleSnapshotRequest(
      store,
      fakeReq("/snapshot/snapshots/../../etc/passwd"),
      res,
    );
    expect(res.status).toBe(400);
    expect(store.getSpy).not.toHaveBeenCalled();
    expect(store.getBytesSpy).not.toHaveBeenCalled();
  });

  test("path not starting with snapshots/: 400", async () => {
    const store = fakeStore({});
    const res = fakeRes();
    await handleSnapshotRequest(store, fakeReq("/snapshot/other/abc.html"), res);
    expect(res.status).toBe(400);
    expect(store.getSpy).not.toHaveBeenCalled();
  });

  test("unknown extension (.js): 400", async () => {
    const store = fakeStore({ "snapshots/x.js": "alert(1)" });
    const res = fakeRes();
    await handleSnapshotRequest(store, fakeReq("/snapshot/snapshots/x.js"), res);
    expect(res.status).toBe(400);
    expect(store.getSpy).not.toHaveBeenCalled();
    expect(store.getBytesSpy).not.toHaveBeenCalled();
  });

  test("missing file: 404", async () => {
    const store = fakeStore({});
    const res = fakeRes();
    await handleSnapshotRequest(store, fakeReq("/snapshot/snapshots/missing.html"), res);
    expect(res.status).toBe(404);
  });

  test("non-GET method: 405", async () => {
    const store = fakeStore({ "snapshots/abc.html": "<p>x</p>" });
    const res = fakeRes();
    await handleSnapshotRequest(
      store,
      fakeReq("/snapshot/snapshots/abc.html", "POST"),
      res,
    );
    expect(res.status).toBe(405);
    expect(store.getSpy).not.toHaveBeenCalled();
  });
});
