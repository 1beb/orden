// Pure helpers behind the code viewer: map a file path to a highlight.js
// language, and split highlight.js's single HTML string into per-line fragments
// so a line-number gutter can render one element per source line.
//
// highlight.js emits a flat string of <span class="hljs-…">…</span> wrappers
// around HTML-escaped text. A single span (e.g. a block comment or template
// literal) can straddle several source lines, so naive splitting on "\n" would
// leave unbalanced tags. splitHighlightedLines tracks the open-span stack and
// closes/re-opens it across every newline.

// Extension → highlight.js language id. Anything unmapped returns undefined so
// the caller falls back to highlightAuto (or plain text for binaries).
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml",
  yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sql: "sql",
};

// Markdown opens in the prose/annotation editor; every other file opens in the
// read-only code viewer. HTML counts as code here even though it sits under the
// Docs filter chip — it's markup, so it reads best highlighted with line numbers.
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
const HTML_EXT = new Set(["html", "htm"]);

function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isCodeFile(path: string): boolean {
  return !MARKDOWN_EXT.has(extOf(path));
}

// Which viewer a file opens in. Markdown → the prose/annotation editor; images
// always render (binary has no source view); HTML renders or shows source per
// `htmlRender` (the effective flag: a per-file override, else the setting);
// everything else is read-only highlighted code.
export type ViewerKind = "prose" | "image" | "html" | "code";

export function viewerFor(path: string, htmlRender: boolean): ViewerKind {
  const ext = extOf(path);
  if (MARKDOWN_EXT.has(ext)) return "prose";
  if (IMAGE_EXT.has(ext)) return "image";
  if (HTML_EXT.has(ext)) return htmlRender ? "html" : "code";
  return "code";
}

export function languageForPath(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

// Split highlight.js HTML into one HTML string per source line, carrying open
// spans across line breaks so every line is independently well-formed.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = []; // open <span …> tags, outermost first
  let cur = "";
  let i = 0;

  const reopen = (): string => stack.join("");
  const closeAll = (): string => "</span>".repeat(stack.length);

  while (i < html.length) {
    if (html[i] === "\n") {
      lines.push(cur + closeAll());
      cur = reopen();
      i += 1;
      continue;
    }
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      cur += tag;
      if (tag.startsWith("</")) stack.pop();
      else stack.push(tag);
      i = end + 1;
      continue;
    }
    // Plain text / entity run up to the next tag or newline — copied verbatim.
    let j = i;
    while (j < html.length && html[j] !== "<" && html[j] !== "\n") j += 1;
    cur += html.slice(i, j);
    i = j;
  }
  lines.push(cur);
  return lines;
}
