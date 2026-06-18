import { fuzzyRank } from "./fuzzy";

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  open: () => void;
}

export interface SearchSource {
  id: string;
  label: string;
  // May resolve synchronously (resident sources: nav, projects, files, cards) or
  // asynchronously (host-backed: pages/journal full-text search). Sync results
  // render on the keystroke; async ones fill in a tick later, guarded so a stale
  // query's late result never clobbers a newer one.
  search: (query: string) => PaletteItem[] | Promise<PaletteItem[]>;
}

export interface Command {
  id: string;
  title: string;
  run: () => void;
}

export interface PaletteDeps {
  form: HTMLFormElement;
  input: HTMLInputElement;
  mount: HTMLElement;
  sources: SearchSource[];
  commands: Command[];
}

export interface PaletteController {
  update: () => void;
  open: (prefill?: string, overlay?: boolean) => void;
  close: () => void;
}

const GROUP_CAP = 4;
const DEBOUNCE_MS = 120;

interface RenderGroup {
  label: string;
  items: PaletteItem[];
  extra: number;
  isCommands: boolean;
}

export function createCommandPalette(deps: PaletteDeps): PaletteController {
  const { form, input, mount, sources, commands } = deps;
  mount.classList.add("palette");
  let flat: PaletteItem[] = []; // current selectable rows, in visual order
  let active = 0;

  // Dim backdrop for overlay (⌘K/⌘P) mode. Created once, lives on <body> so the
  // overlay floats above the whole app rather than inside the topbar.
  const backdrop = document.createElement("div");
  backdrop.className = "palette-backdrop";
  document.body.append(backdrop);
  backdrop.addEventListener("mousedown", () => close());

  function rankCommands(q: string): PaletteItem[] {
    return fuzzyRank(q, commands, (c) => c.title).map(({ item }) => ({
      id: item.id,
      title: item.title,
      open: item.run,
    }));
  }

  function render(groups: RenderGroup[]): void {
    mount.replaceChildren();
    flat = [];
    if (groups.length === 0) {
      mount.classList.remove("open");
      return;
    }
    for (const g of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "palette-group";
      if (!g.isCommands) groupEl.setAttribute("data-source", g.label);
      const head = document.createElement("div");
      head.className = "palette-group-head";
      head.textContent = g.label;
      groupEl.append(head);
      for (const item of g.items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "palette-row";
        row.textContent = item.title;
        if (item.subtitle) {
          const sub = document.createElement("span");
          sub.className = "palette-sub";
          sub.textContent = item.subtitle;
          row.append(sub);
        }
        const idx = flat.length;
        row.addEventListener("click", () => choose(idx));
        flat.push(item);
        groupEl.append(row);
      }
      if (g.extra > 0) {
        const more = document.createElement("div");
        more.className = "palette-more";
        more.textContent = `+${g.extra} more`;
        groupEl.append(more);
      }
      mount.append(groupEl);
    }
    active = 0;
    paintActive();
    mount.classList.add("open");
  }

  function paintActive(): void {
    const rows = [...mount.querySelectorAll<HTMLElement>(".palette-row")];
    rows.forEach((r, i) => r.classList.toggle("active", i === active));
  }

  function choose(idx: number): void {
    const item = flat[idx];
    if (!item) return;
    close();
    item.open();
  }

  // Per-query token: each update() bumps it; an async source's resolved result
  // only renders if its token is still the latest, so a slow query that lands
  // after a newer keystroke is discarded rather than flashing stale results.
  let queryToken = 0;

  function buildGroups(resolved: PaletteItem[][]): RenderGroup[] {
    return sources
      .map((s, i): RenderGroup => {
        const all = resolved[i];
        return {
          label: s.label,
          items: all.slice(0, GROUP_CAP),
          extra: Math.max(0, all.length - GROUP_CAP),
          isCommands: false,
        };
      })
      .filter((g) => g.items.length > 0);
  }

  function update(): void {
    const raw = input.value;
    if (raw.startsWith(">")) {
      queryToken++; // invalidate any in-flight async search-source results
      const q = raw.slice(1).trim();
      const items = rankCommands(q);
      render(items.length ? [{ label: "Commands", items, extra: 0, isCommands: true }] : []);
      return;
    }
    const q = raw.trim();
    const token = ++queryToken;
    const results = sources.map((s) => s.search(q));
    // Render synchronously-available sources now (snappy nav); async sources
    // contribute an empty group this pass and fill in once they resolve.
    render(buildGroups(results.map((r) => (Array.isArray(r) ? r : []))));
    if (results.every((r) => Array.isArray(r))) return;
    void Promise.all(results.map((r) => Promise.resolve(r))).then((all) => {
      if (token !== queryToken) return; // a newer query superseded this one
      render(buildGroups(all));
    });
  }

  // Debounce live typing so we don't fire a host query on every keystroke; the
  // stale-token guard in update() keeps results correct regardless. Programmatic
  // entry points (open, Enter/submit) flush immediately for responsiveness.
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleUpdate(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      update();
    }, DEBOUNCE_MS);
  }
  function flushUpdate(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    update();
  }

  function open(prefill?: string, overlay = false): void {
    if (prefill !== undefined) input.value = prefill;
    form.classList.toggle("overlay", overlay);
    backdrop.classList.toggle("open", overlay);
    input.focus();
    flushUpdate();
  }

  function close(): void {
    mount.classList.remove("open");
    mount.replaceChildren();
    form.classList.remove("overlay");
    backdrop.classList.remove("open");
    flat = [];
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    choose(active);
  });
  input.addEventListener("input", scheduleUpdate);

  input.addEventListener("keydown", (e) => {
    const rows = flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows) { active = (active + 1) % rows; paintActive(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows) { active = (active - 1 + rows) % rows; paintActive(); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Two-stage: a first press clears a non-empty query (palette stays open
      // showing the empty-query results); a second press closes and blurs.
      if (input.value !== "") {
        input.value = "";
        update();
      } else {
        close();
        input.blur();
      }
    }
  });

  return { update, open, close };
}
