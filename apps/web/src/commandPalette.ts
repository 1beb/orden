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
  search: (query: string) => PaletteItem[];
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

  function update(): void {
    const raw = input.value;
    if (raw.startsWith(">")) {
      const q = raw.slice(1).trim();
      const items = rankCommands(q);
      render(items.length ? [{ label: "Commands", items, extra: 0, isCommands: true }] : []);
      return;
    }
    const q = raw.trim();
    const groups = sources
      .map((s): RenderGroup => {
        const all = s.search(q);
        return {
          label: s.label,
          items: all.slice(0, GROUP_CAP),
          extra: Math.max(0, all.length - GROUP_CAP),
          isCommands: false,
        };
      })
      .filter((g) => g.items.length > 0);
    render(groups);
  }

  function open(prefill?: string, overlay = false): void {
    if (prefill !== undefined) input.value = prefill;
    form.classList.toggle("overlay", overlay);
    backdrop.classList.toggle("open", overlay);
    input.focus();
    update();
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
  input.addEventListener("input", update);

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
