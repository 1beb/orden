// A small, SAFE markdown → DOM renderer for chat text parts. Builds real DOM
// nodes with textContent (never innerHTML), so there is no XSS surface. Supports
// the common subset: fenced code blocks, inline code, bold, italic, headings,
// bullet/numbered lists, and links. Not a full CommonMark implementation — good
// enough to make assistant replies readable; swap for a real lib later if needed.

function safeUrl(url: string): string {
  const u = url.trim();
  // Allow http(s), mailto, and relative/anchor links; block javascript: etc.
  if (/^(https?:|mailto:|\/|#|\.)/i.test(u)) return u;
  return "#";
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)]+\))/g;

function appendInlineSegment(parent: Node, text: string): void {
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("`")) {
      const c = document.createElement("code");
      c.className = "chat-md-inline-code";
      c.textContent = tok.slice(1, -1);
      parent.appendChild(c);
    } else if (tok.startsWith("**")) {
      const b = document.createElement("strong");
      b.textContent = tok.slice(2, -2);
      parent.appendChild(b);
    } else if (tok.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const a = document.createElement("a");
      a.textContent = lm ? lm[1] : tok;
      a.href = lm ? safeUrl(lm[2]) : "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    } else {
      const it = document.createElement("em");
      it.textContent = tok.slice(1, -1);
      parent.appendChild(it);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function appendInline(parent: Node, text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) parent.appendChild(document.createElement("br"));
    appendInlineSegment(parent, line);
  });
}

const LIST_RE = /^\s*([-*]|\d+\.)\s+/;

export function renderMarkdown(src: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "chat-md";
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const pre = document.createElement("pre");
      pre.className = "chat-md-code";
      const codeEl = document.createElement("code");
      if (fence[1]) codeEl.dataset.lang = fence[1];
      codeEl.textContent = code.join("\n");
      pre.appendChild(codeEl);
      root.appendChild(pre);
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const el = document.createElement(`h${h[1].length}` as "h1");
      el.className = "chat-md-h";
      appendInline(el, h[2]);
      root.appendChild(el);
      i++;
      continue;
    }

    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const listEl = document.createElement(ordered ? "ol" : "ul");
      listEl.className = "chat-md-list";
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(LIST_RE, ""));
        listEl.appendChild(li);
        i++;
      }
      root.appendChild(listEl);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    p.className = "chat-md-p";
    appendInline(p, para.join("\n"));
    root.appendChild(p);
  }

  return root;
}
