import { describe, it, expect, beforeEach } from "vitest";
import type { VaultStore } from "@orden/host-api";
import { sourceHash } from "@orden/annotation-core";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";
import { contentHash } from "../../src/clipper/contentHash";
import type { SnapshotStore } from "../../src/clipper/snapshotStore";
import { applyCapture, type ApplyCaptureDeps, type CaptureBundle } from "../../src/clipper/applyCapture";

// ---- Fakes -----------------------------------------------------------------

class FakeVault implements VaultStore {
  store = new Map<string, unknown>();
  private k(ns: string, key: string) {
    return `${ns} ${key}`;
  }
  async get<T>(ns: string, key: string): Promise<T | null> {
    return (this.store.has(this.k(ns, key)) ? (this.store.get(this.k(ns, key)) as T) : null);
  }
  async set<T>(ns: string, key: string, value: T): Promise<void> {
    this.store.set(this.k(ns, key), value);
  }
  async list(ns: string): Promise<string[]> {
    const prefix = `${ns} `;
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
  async delete(ns: string, key: string): Promise<void> {
    this.store.delete(this.k(ns, key));
  }
}

class FakeSnapshotStore implements SnapshotStore {
  files = new Map<string, string | Buffer>();
  async put(hash: string, ext: string, bytes: string | Buffer): Promise<string> {
    const rel = `snapshots/${hash}.${ext}`;
    if (!this.files.has(rel)) this.files.set(rel, bytes);
    return rel;
  }
  async get(snapshotPath: string): Promise<string | null> {
    const v = this.files.get(snapshotPath);
    if (v == null) return null;
    return Buffer.isBuffer(v) ? v.toString("utf8") : v;
  }
  async getBytes(snapshotPath: string): Promise<Buffer | null> {
    const v = this.files.get(snapshotPath);
    if (v == null) return null;
    return Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8");
  }
}

// ---- Helpers ---------------------------------------------------------------

function makeDeps(over: Partial<ApplyCaptureDeps> = {}): {
  deps: ApplyCaptureDeps;
  vault: FakeVault;
  store: FakeSnapshotStore;
} {
  const vault = new FakeVault();
  const store = new FakeSnapshotStore();
  let n = 0;
  const deps: ApplyCaptureDeps = {
    vault,
    store,
    mintId: () => `id-${n++}`,
    now: () => "2026-06-08T00:00:00.000Z",
    journalKeyFor: () => "2026-06-08",
    ...over,
  };
  return { deps, vault, store };
}

function bundle(over: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    url: "https://example.com/article",
    title: "An Article",
    snapshotHtml: "<p data-oid='b1'>hello world</p>",
    ext: "html",
    highlights: [
      {
        exact: "hello",
        prefix: "",
        suffix: " world",
        blockId: "b1",
        note: "agent please look",
        audience: "agent",
      },
    ],
    routing: {},
    ...over,
  };
}

// ---- Tests -----------------------------------------------------------------

describe("applyCapture", () => {
  it("writes a snapshot and an annotations bundle matching highlights", async () => {
    const { deps, vault, store } = makeDeps();
    const b = bundle();
    const hash = contentHash(b.snapshotHtml);

    const res = await applyCapture(deps, b);

    expect(res.contentHash).toBe(hash);
    expect(res.snapshotPath).toBe(`snapshots/${hash}.html`);
    expect(await store.get(res.snapshotPath)).toBe(b.snapshotHtml);

    const source: Source = {
      kind: "web",
      url: b.url,
      snapshotPath: res.snapshotPath,
      contentHash: hash,
      title: b.title,
    };
    const rec = await vault.get<{ source: Source; annotations: OrdenAnnotation[] }>(
      "annotations",
      sourceHash(source),
    );
    expect(rec).not.toBeNull();
    expect(rec!.source).toEqual(source);
    expect(rec!.annotations.length).toBe(b.highlights.length);
    expect(res.annotationCount).toBe(1);
  });

  it("preserves agent vs human audience on records", async () => {
    const { deps, vault } = makeDeps();
    const b = bundle({
      highlights: [
        { exact: "a", prefix: "", suffix: "", blockId: "b1", note: "n1", audience: "agent" },
        { exact: "b", prefix: "", suffix: "", blockId: "b2", note: "n2", audience: "human" },
      ],
    });
    await applyCapture(deps, b);
    const hash = contentHash(b.snapshotHtml);
    const source: Source = { kind: "web", url: b.url, snapshotPath: `snapshots/${hash}.html`, contentHash: hash, title: b.title };
    const rec = await vault.get<{ annotations: OrdenAnnotation[] }>("annotations", sourceHash(source));
    expect(rec!.annotations.map((a) => a["orden:audience"])).toEqual(["agent", "human"]);
  });

  it("stores a screenshot and links it via orden:shot; bare highlights have none", async () => {
    const { deps, vault, store } = makeDeps();
    const shot = Buffer.from([9, 8, 7]).toString("base64");
    const b = bundle({
      highlights: [
        { exact: "a", prefix: "", suffix: "", blockId: "b1", note: "n1", audience: "agent", shotBase64: shot },
        { exact: "b", prefix: "", suffix: "", blockId: "b2", note: "n2", audience: "human" },
      ],
    });
    await applyCapture(deps, b);
    const hash = contentHash(b.snapshotHtml);
    const shotPath = `snapshots/${hash}-0.webp`;
    expect(await store.getBytes(shotPath)).toEqual(Buffer.from([9, 8, 7]));

    const source: Source = { kind: "web", url: b.url, snapshotPath: `snapshots/${hash}.html`, contentHash: hash, title: b.title };
    const rec = await vault.get<{ annotations: OrdenAnnotation[] }>("annotations", sourceHash(source));
    expect(rec!.annotations[0]["orden:shot"]).toBe(shotPath);
    expect(rec!.annotations[1]["orden:shot"]).toBeUndefined();
  });

  it("appends exactly one journal bullet containing url + count to an empty page", async () => {
    const { deps, vault } = makeDeps();
    const b = bundle();
    await applyCapture(deps, b);
    const page = await vault.get<string>("pages", "2026-06-08");
    expect(page).not.toBeNull();
    const lines = page!.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith("- ")).toBe(true);
    expect(lines[0]).toContain(b.url);
    expect(lines[0]).toContain("1 highlight");
  });

  it("preserves existing journal content and adds the new bullet on its own line", async () => {
    const { deps, vault } = makeDeps();
    await vault.set("pages", "2026-06-08", "- existing todo");
    const b = bundle();
    await applyCapture(deps, b);
    const page = await vault.get<string>("pages", "2026-06-08");
    expect(page).toContain("- existing todo");
    const lines = page!.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("- existing todo");
    expect(lines[1].startsWith("- ")).toBe(true);
    expect(lines[1]).toContain(b.url);
  });

  it("creates no session when projectId is empty", async () => {
    let called = 0;
    const { deps, vault } = makeDeps({ createSession: async () => { called++; return "s1"; } });
    await applyCapture(deps, bundle({ routing: {} }));
    expect(called).toBe(0);
    const res = await applyCapture(deps, bundle({ routing: { projectId: "" } }));
    expect(res.sessionId).toBeUndefined();
    expect(await vault.list("sessions")).toEqual([]);
  });

  it("creates no session when createSession is absent even with projectId", async () => {
    const { deps } = makeDeps();
    const res = await applyCapture(deps, bundle({ routing: { projectId: "proj-1" } }));
    expect(res.sessionId).toBeUndefined();
  });

  it("creates a session once with projectId and a prompt carrying instructions", async () => {
    const calls: Array<{ projectId: string; prompt: string }> = [];
    const { deps } = makeDeps({
      createSession: async (projectId, prompt) => {
        calls.push({ projectId, prompt });
        return "sess-42";
      },
    });
    const b = bundle({
      routing: { projectId: "proj-1", instructions: "summarize this please" },
    });
    const res = await applyCapture(deps, b);
    expect(calls.length).toBe(1);
    expect(calls[0].projectId).toBe("proj-1");
    expect(calls[0].prompt).toContain("summarize this please");
    expect(calls[0].prompt).toContain(b.url);
    expect(res.sessionId).toBe("sess-42");
  });

  it("creates a session even with a thin prompt (projectId, no instructions, no agent notes)", async () => {
    const calls: Array<{ projectId: string; prompt: string }> = [];
    const { deps } = makeDeps({
      createSession: async (projectId, prompt) => {
        calls.push({ projectId, prompt });
        return "sess-thin";
      },
    });
    const b = bundle({
      routing: { projectId: "proj-1" },
      highlights: [
        { exact: "a", prefix: "", suffix: "", blockId: "b1", note: "n1", audience: "human" },
      ],
    });
    const res = await applyCapture(deps, b);
    expect(calls.length).toBe(1);
    expect(calls[0].projectId).toBe("proj-1");
    expect(calls[0].prompt).toContain(b.url);
    expect(calls[0].prompt).toContain(b.title);
    expect(res.sessionId).toBe("sess-thin");
  });

  it("sanitizes the journal bullet: a title with a newline and [[evil]] stays one line with no wiki markers", async () => {
    const { deps, vault } = makeDeps();
    const b = bundle({ title: "Evil\nTitle [[evil]] more" });
    await applyCapture(deps, b);
    const page = await vault.get<string>("pages", "2026-06-08");
    expect(page).not.toBeNull();
    expect(page!.split("\n").length).toBe(1);
    expect(page).not.toContain("[[");
    expect(page).not.toContain("]]");
    expect(page!.startsWith("- ")).toBe(true);
  });

  it("appends the journal bullet and snapshot but no annotations for empty highlights, reading '0 highlights'", async () => {
    const { deps, vault, store } = makeDeps();
    const b = bundle({ highlights: [] });
    const res = await applyCapture(deps, b);

    // snapshot still stored
    expect(await store.get(res.snapshotPath)).toBe(b.snapshotHtml);

    // zero annotations in the bundle
    const hash = contentHash(b.snapshotHtml);
    const source: Source = { kind: "web", url: b.url, snapshotPath: res.snapshotPath, contentHash: hash, title: b.title };
    const rec = await vault.get<{ annotations: OrdenAnnotation[] }>("annotations", sourceHash(source));
    expect(rec).not.toBeNull();
    expect(rec!.annotations.length).toBe(0);
    expect(res.annotationCount).toBe(0);

    // journal bullet still appended, reads "0 highlights"
    const page = await vault.get<string>("pages", "2026-06-08");
    const lines = page!.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith("- ")).toBe(true);
    expect(lines[0]).toContain("0 highlights");
  });

  it("pluralizes the journal bullet count for two highlights", async () => {
    const { deps, vault } = makeDeps();
    const b = bundle({
      highlights: [
        { exact: "a", prefix: "", suffix: "", blockId: "b1", note: "n1", audience: "agent" },
        { exact: "b", prefix: "", suffix: "", blockId: "b2", note: "n2", audience: "human" },
      ],
    });
    await applyCapture(deps, b);
    const page = await vault.get<string>("pages", "2026-06-08");
    const lines = page!.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[0]).toContain("2 highlights");
  });

  it("journal-once: re-capturing the same source appends ONE bullet but upserts annotations", async () => {
    const { deps, vault } = makeDeps();
    const b1 = bundle();
    const hash = contentHash(b1.snapshotHtml);
    const source: Source = {
      kind: "web",
      url: b1.url,
      snapshotPath: `snapshots/${hash}.html`,
      contentHash: hash,
      title: b1.title,
    };

    const r1 = await applyCapture(deps, b1);
    expect(r1.firstCapture).toBe(true);

    // Second submit: same page/snapshot ⇒ same sourceHash, but edited annotations.
    const b2 = bundle({
      highlights: [
        { exact: "hello", prefix: "", suffix: " world", blockId: "b1", note: "n1", audience: "agent" },
        { exact: "world", prefix: "hello ", suffix: "", blockId: "b1", note: "n2", audience: "human" },
      ],
    });
    const r2 = await applyCapture(deps, b2);
    expect(r2.firstCapture).toBe(false);

    // Journal: exactly one bullet (not two).
    const page = await vault.get<string>("pages", "2026-06-08");
    const lines = page!.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    // Annotations: reflect the SECOND call (upsert), not the first.
    const rec = await vault.get<{ annotations: OrdenAnnotation[] }>("annotations", sourceHash(source));
    expect(rec!.annotations.length).toBe(2);
    expect(r2.annotationCount).toBe(2);
  });

  it("journal-once: a session is created only on the first capture, not on re-sync", async () => {
    let called = 0;
    const { deps } = makeDeps({
      createSession: async () => {
        called++;
        return `sess-${called}`;
      },
    });
    const b = bundle({ routing: { projectId: "proj-1", instructions: "do it" } });

    const r1 = await applyCapture(deps, b);
    expect(called).toBe(1);
    expect(r1.sessionId).toBe("sess-1");
    expect(r1.firstCapture).toBe(true);

    const r2 = await applyCapture(deps, b);
    expect(called).toBe(1); // not spawned again
    expect(r2.sessionId).toBeUndefined();
    expect(r2.firstCapture).toBe(false);
  });
});
