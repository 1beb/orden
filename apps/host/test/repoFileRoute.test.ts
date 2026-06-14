import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoFile, repoFileMime, handleRepoFileRequest } from "../src/repoFileRoute";
import type { ProjectRootResolver } from "../src/projectRoots";

// A tmp dir standing in for project "pa"'s files root, with one real file.
const ROOT = mkdtempSync(join(tmpdir(), "repo-file-"));
writeFileSync(join(ROOT, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

// Fake resolver: only "pa" resolves; everything else is undefined.
const resolve: ProjectRootResolver = async (id) => (id === "pa" ? ROOT : undefined);

describe("resolveRepoFile", () => {
  it("resolves a plain repo-relative path under the project's root", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa/docs/a.png")).toBe(
      join(ROOT, "docs/a.png"),
    );
  });

  it("decodes percent-encoded path segments", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa/my%20notes/x.png")).toBe(
      join(ROOT, "my notes/x.png"),
    );
  });

  it("strips a query string", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa/a.png?v=2")).toBe(join(ROOT, "a.png"));
  });

  it("returns null for an unknown project id", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/nope/a.png")).toBeNull();
  });

  it("returns null (does not reject) when the resolver throws", async () => {
    const throwingResolver: ProjectRootResolver = async () => {
      throw new Error("vault boom");
    };
    expect(await resolveRepoFile(throwingResolver, "/repo-file/pa/a.png")).toBeNull();
  });

  it("serves an absolute path under the 'host' root (root '/')", async () => {
    // The "host" project resolves to "/", so an absolute rel path joins to
    // itself and passes the guard — this is how arbitrary referenced files open.
    const hostResolve: ProjectRootResolver = async (id) => (id === "host" ? "/" : undefined);
    expect(await resolveRepoFile(hostResolve, `/repo-file/host${join(ROOT, "a.png")}`)).toBe(
      join(ROOT, "a.png"),
    );
  });

  it("rejects a path that escapes the root via ..", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa/../escape")).toBeNull();
  });

  it("rejects an encoded traversal escape", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  it("rejects malformed percent-encoding in the path", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa/%zz.png")).toBeNull();
  });

  it("returns null when the url is not under the /repo-file/ prefix", async () => {
    expect(await resolveRepoFile(resolve, "/something/else")).toBeNull();
  });

  it("returns null when the project id is missing", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/")).toBeNull();
  });

  it("returns null when the rel path is missing", async () => {
    expect(await resolveRepoFile(resolve, "/repo-file/pa")).toBeNull();
    expect(await resolveRepoFile(resolve, "/repo-file/pa/")).toBeNull();
  });
});

describe("repoFileMime", () => {
  it("maps common image extensions", () => {
    expect(repoFileMime("a.png")).toBe("image/png");
    expect(repoFileMime("a.jpg")).toBe("image/jpeg");
    expect(repoFileMime("a.jpeg")).toBe("image/jpeg");
    expect(repoFileMime("a.gif")).toBe("image/gif");
    expect(repoFileMime("a.svg")).toBe("image/svg+xml");
    expect(repoFileMime("a.webp")).toBe("image/webp");
  });

  it("is case-insensitive on the extension", () => {
    expect(repoFileMime("A.PNG")).toBe("image/png");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(repoFileMime("a.bin")).toBe("application/octet-stream");
  });
});

// Minimal mock req/res to exercise the handler's status codes.
function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as Buffer | string | undefined,
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) this.headers = headers;
      return this;
    },
    end(body?: Buffer | string) {
      this.body = body;
      return this;
    },
  };
  return res;
}

describe("handleRepoFileRequest", () => {
  it("returns false for urls not under the prefix", async () => {
    const res = mockRes();
    const handled = await handleRepoFileRequest(resolve, { url: "/other" } as never, res as never);
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });

  it("serves 200 with mime for a real file", async () => {
    const res = mockRes();
    const handled = await handleRepoFileRequest(
      resolve,
      { url: "/repo-file/pa/a.png" } as never,
      res as never,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it("returns 403 when the resolver yields no root", async () => {
    const res = mockRes();
    const handled = await handleRepoFileRequest(
      resolve,
      { url: "/repo-file/nope/a.png" } as never,
      res as never,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for a missing file under a known project", async () => {
    const res = mockRes();
    const handled = await handleRepoFileRequest(
      resolve,
      { url: "/repo-file/pa/missing.png" } as never,
      res as never,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});
