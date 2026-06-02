import { describe, expect, it } from "vitest";
import { resolveRepoFile, repoFileMime } from "../src/repoFileRoute";

const ROOT = "/srv/repo";

describe("resolveRepoFile", () => {
  it("resolves a plain repo-relative path under the root", () => {
    expect(resolveRepoFile(ROOT, "/repo-file/docs/a.png")).toBe("/srv/repo/docs/a.png");
  });

  it("decodes percent-encoded path segments", () => {
    expect(resolveRepoFile(ROOT, "/repo-file/my%20notes/x.png")).toBe("/srv/repo/my notes/x.png");
  });

  it("strips a query string", () => {
    expect(resolveRepoFile(ROOT, "/repo-file/a.png?v=2")).toBe("/srv/repo/a.png");
  });

  it("rejects a path that escapes the root via ..", () => {
    expect(resolveRepoFile(ROOT, "/repo-file/../../etc/passwd")).toBeNull();
  });

  it("rejects an encoded traversal escape", () => {
    expect(resolveRepoFile(ROOT, "/repo-file/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  it("returns null when the url is not under the /repo-file/ prefix", () => {
    expect(resolveRepoFile(ROOT, "/something/else")).toBeNull();
  });

  it("returns null for an empty file path", () => {
    expect(resolveRepoFile(ROOT, "/repo-file/")).toBeNull();
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
