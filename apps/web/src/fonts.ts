// Font registry + application. The app's reading/UI font and base size are
// selectable in Settings; a curated set of Google Fonts (plus the system
// stack). applyFont injects the Google stylesheet on demand and drives two CSS
// variables (--app-font, --font-scale) consumed throughout styles.css. Every
// font-size is calc(<px> * var(--font-scale)), so the base size sets the scale.

export interface FontOption {
  id: string;
  label: string;
  stack: string; // CSS font-family value
  google?: string; // Google Fonts family name (spaces become "+")
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "system",
    label: "System",
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  {
    id: "atkinson",
    label: "Atkinson Hyperlegible",
    stack: '"Atkinson Hyperlegible", sans-serif',
    google: "Atkinson Hyperlegible",
  },
  { id: "inter", label: "Inter", stack: '"Inter", sans-serif', google: "Inter" },
  { id: "lora", label: "Lora (serif)", stack: '"Lora", Georgia, serif', google: "Lora" },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    google: "JetBrains Mono",
  },
];

export const DEFAULT_FONT_ID = "system";

export function fontOption(id: string): FontOption {
  return FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0];
}

export function googleFontHref(opt: FontOption): string | null {
  if (!opt.google) return null;
  const family = opt.google.replace(/ /g, "+");
  return `https://fonts.googleapis.com/css2?family=${family}:ital,wght@0,400;0,600;0,700;1,400&display=swap`;
}

function ensureFontLink(id: string, href: string): void {
  const linkId = `font-${id}`;
  if (document.getElementById(linkId)) return;
  const link = document.createElement("link");
  link.id = linkId;
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

/** Load the chosen font (if it's a Google font) and apply family + size. */
export function applyFont(
  id: string,
  sizePx: number,
  root: HTMLElement = document.documentElement,
): void {
  const opt = fontOption(id);
  const href = googleFontHref(opt);
  if (href) ensureFontLink(opt.id, href);
  root.style.setProperty("--app-font", opt.stack);
  root.style.setProperty("--app-font-size", `${sizePx}px`);
  // Base size 16px == scale 1; the slider's 12–24px maps to 0.75×–1.5×.
  root.style.setProperty("--font-scale", String(sizePx / 16));
}
