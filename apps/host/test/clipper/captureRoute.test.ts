import { describe, test, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isClipperRequest, handleCaptureRequest } from "../../src/clipper/captureRoute";
import type { CaptureBundle, ApplyCaptureResult } from "../../src/clipper/applyCapture";

// Fake IncomingMessage: a readable-ish emitter that pushes the given body then
// ends on the next tick, so handleCaptureRequest's readBody resolves. Mirrors the
// req shim style in hooks.test.ts (drive data/end via the event API).
function fakeReq(body: string, method = "POST"): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { headers?: Record<string, string> }).headers = { "x-orden-clipper": "1" };
  queueMicrotask(() => {
    if (body.length > 0) req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

// Fake ServerResponse: records the writeHead status and the end() body.
function fakeRes(): ServerResponse & { status?: number; body?: string } {
  const res = {
    status: undefined as number | undefined,
    body: undefined as string | undefined,
    writeHead(code: number, _headers?: unknown) {
      this.status = code;
      return this;
    },
    end(chunk?: string) {
      this.body = chunk;
      return this;
    },
  };
  return res as unknown as ServerResponse & { status?: number; body?: string };
}

const validBundle: CaptureBundle = {
  url: "https://example.com/article",
  title: "An Article",
  snapshotHtml: "<article>hi</article>",
  ext: "html",
  highlights: [],
  routing: {},
};

const result: ApplyCaptureResult = {
  snapshotPath: "snapshots/abc.html",
  contentHash: "abc",
  annotationCount: 0,
  journalKey: "2026-06-08",
};

describe("isClipperRequest (CSRF header guard)", () => {
  test("POST with the clipper header is true", () => {
    expect(isClipperRequest({ method: "POST", headers: { "x-orden-clipper": "1" } })).toBe(true);
  });

  test("POST without the header is false", () => {
    expect(isClipperRequest({ method: "POST", headers: {} })).toBe(false);
  });

  test("GET with the header is false", () => {
    expect(isClipperRequest({ method: "GET", headers: { "x-orden-clipper": "1" } })).toBe(false);
  });
});

describe("handleCaptureRequest", () => {
  test("valid bundle: apply called once with the parsed bundle, 200 + result JSON", async () => {
    const apply = vi.fn(async () => result);
    const res = fakeRes();
    await handleCaptureRequest(fakeReq(JSON.stringify(validBundle)), res, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(validBundle);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual(result);
  });

  test("malformed JSON body: 400, apply NOT called", async () => {
    const apply = vi.fn(async () => result);
    const res = fakeRes();
    await handleCaptureRequest(fakeReq("{not json"), res, apply);
    expect(apply).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!).error).toBeTruthy();
  });

  test("structurally-invalid bundle (missing snapshotHtml): 400, apply NOT called", async () => {
    const apply = vi.fn(async () => result);
    const res = fakeRes();
    const { snapshotHtml: _drop, ...bad } = validBundle;
    await handleCaptureRequest(fakeReq(JSON.stringify(bad)), res, apply);
    expect(apply).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body!).error).toBeTruthy();
  });
});
