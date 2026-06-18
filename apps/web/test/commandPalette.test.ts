import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandPalette } from "../src/commandPalette";
import type { SearchSource, Command, PaletteItem } from "../src/commandPalette";

afterEach(() => document.body.replaceChildren());

function harness(sources: SearchSource[], commands: Command[] = []) {
  const form = document.createElement("form");
  const input = document.createElement("input");
  const mount = document.createElement("div");
  form.append(input);
  document.body.append(form, mount);
  const palette = createCommandPalette({ form, input, mount, sources, commands });
  return { form, input, mount, palette };
}

const src = (id: string, items: string[]): SearchSource => ({
  id,
  label: id,
  search: (q) =>
    items
      .filter((t) => t.includes(q))
      .map((t) => ({ id: `${id}:${t}`, title: t, open: vi.fn() })),
});

describe("command palette query routing", () => {
  it("groups results by source in registration order, capped at 4", () => {
    const { input, mount, palette } = harness([
      src("Journal", ["ja", "jb"]),
      src("Files", ["fa", "fb", "fc", "fd", "fe"]),
    ]);
    input.value = "";
    palette.update();
    const groups = [...mount.querySelectorAll(".palette-group")];
    expect(groups.map((g) => g.getAttribute("data-source"))).toEqual([
      "Journal",
      "Files",
    ]);
    const fileRows = mount.querySelectorAll('[data-source="Files"] .palette-row');
    expect(fileRows).toHaveLength(4); // capped
    expect(mount.querySelector('[data-source="Files"] .palette-more')?.textContent)
      .toContain("1 more");
  });

  it("> switches to command mode and filters commands", () => {
    const run = vi.fn();
    const { input, mount, palette } = harness(
      [src("Files", ["fa"])],
      [{ id: "c1", title: "New session", run }],
    );
    input.value = ">new";
    palette.update();
    expect(mount.querySelector(".palette-group[data-source]")).toBeNull(); // no search groups
    const rows = mount.querySelectorAll(".palette-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("New session");
  });

  it("omits empty groups", () => {
    const { input, mount, palette } = harness([src("Pages", ["zzz"])]);
    input.value = "qqq";
    palette.update();
    expect(mount.querySelector(".palette-group")).toBeNull();
  });
});

describe("async search sources", () => {
  it("renders results from an async source once it resolves", async () => {
    const { input, mount, palette } = harness([
      {
        id: "Pages",
        label: "Pages",
        search: async (q) => [{ id: `p:${q}`, title: `Hit ${q}`, open: vi.fn() }],
      },
    ]);
    input.value = "foo";
    palette.update();
    // Async source contributes nothing synchronously.
    expect(mount.querySelectorAll(".palette-row")).toHaveLength(0);
    await vi.waitFor(() => expect(mount.querySelectorAll(".palette-row")).toHaveLength(1));
    expect(mount.querySelector(".palette-row")?.textContent).toContain("Hit foo");
  });

  it("renders sync sources immediately and fills async ones a tick later", async () => {
    const { input, mount, palette } = harness([
      { id: "Nav", label: "Nav", search: (q) => [{ id: "n", title: `Nav ${q}`, open: vi.fn() }] },
      {
        id: "Pages",
        label: "Pages",
        search: async (q) => [{ id: "p", title: `Page ${q}`, open: vi.fn() }],
      },
    ]);
    input.value = "x";
    palette.update();
    // Sync "Nav" group renders now; async "Pages" not yet.
    expect([...mount.querySelectorAll(".palette-group")].map((g) => g.getAttribute("data-source"))).toEqual([
      "Nav",
    ]);
    await vi.waitFor(() =>
      expect([...mount.querySelectorAll(".palette-group")].map((g) => g.getAttribute("data-source"))).toEqual([
        "Nav",
        "Pages",
      ]),
    );
  });

  it("ignores a stale async result when a newer query supersedes it", async () => {
    let resolveFirst!: (v: PaletteItem[]) => void;
    const first = new Promise<PaletteItem[]>((r) => (resolveFirst = r));
    const { input, mount, palette } = harness([
      {
        id: "Pages",
        label: "Pages",
        search: (q) =>
          q === "old" ? first : Promise.resolve([{ id: "p:new", title: "New result", open: vi.fn() }]),
      },
    ]);
    input.value = "old";
    palette.update(); // token 1, awaiting `first`
    input.value = "new";
    palette.update(); // token 2, resolves to "New result"
    await vi.waitFor(() =>
      expect(mount.querySelector(".palette-row")?.textContent).toContain("New result"),
    );
    // The stale first query resolves late — it must NOT replace current results.
    resolveFirst([{ id: "p:old", title: "Old result", open: vi.fn() }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(mount.querySelector(".palette-row")?.textContent).toContain("New result");
  });
});

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("palette keyboard", () => {
  it("ArrowDown/Up moves the active row and wraps", () => {
    const { input, mount, palette } = harness([src("Files", ["fa", "fb"])]);
    palette.open("f");
    press(input, "ArrowDown");
    expect(mount.querySelectorAll(".palette-row")[1].classList.contains("active")).toBe(true);
    press(input, "ArrowDown"); // wrap to top
    expect(mount.querySelectorAll(".palette-row")[0].classList.contains("active")).toBe(true);
  });

  it("Enter opens the active row and closes", () => {
    const open = vi.fn();
    const sources: SearchSource[] = [
      { id: "Files", label: "Files", search: () => [{ id: "x", title: "x", open }] },
    ];
    const { input, mount, palette } = harness(sources);
    palette.open("");
    press(input, "Enter");
    expect(open).toHaveBeenCalledOnce();
    expect(mount.classList.contains("open")).toBe(false);
  });

  it("Escape clears a non-empty query first, then closes on a second press", () => {
    const { input, mount, palette } = harness([src("Files", ["fa"])]);
    palette.open("fa");
    press(input, "Escape");
    expect(input.value).toBe(""); // first Esc clears, palette stays open
    expect(mount.classList.contains("open")).toBe(true);
    press(input, "Escape");
    expect(mount.classList.contains("open")).toBe(false); // second Esc closes
  });
});
