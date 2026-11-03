/**
 * A tiny, safe markdown subset for assistant answers (pure; rendered as React elements, never as HTML).
 * Blocks: paragraphs (single newlines become line breaks), "- " / "* " / "• " bullet lists, "1. " numbered lists,
 * "#" headings. Inline: **bold**, *italic* / _italic_, `code`, and citation markers [n], [1, 3], [2–4].
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "cite"; ns: number[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] };

const BULLET = /^\s*(?:[-*•])\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { endPara(); continue; }
    const h = HEADING.exec(line);
    if (h) { endPara(); blocks.push({ t: "h", c: parseInline(h[1]) }); continue; }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      endPara();
      const ordered = !!n;
      const items: Inline[][] = [];
      const start = n ? Number(n[1]) : 1;
      let j = i;
      for (; j < lines.length; j++) {
        const m = ordered ? NUMBERED.exec(lines[j]) : BULLET.exec(lines[j]);
        if (m) { items.push(parseInline(ordered ? m[2] : m[1])); continue; }
        // An indented continuation line belongs to the previous item.
        if (lines[j].trim() && /^\s{2,}/.test(lines[j]) && items.length) {
          items[items.length - 1].push({ t: "br" }, ...parseInline(lines[j].trim()));
          continue;
        }
        break;
      }
      i = j - 1;
      blocks.push(ordered ? { t: "ol", start, items } : { t: "ul", items });
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

const CITE = /^\[(\d+(?:\s*(?:[,;]|[-–])\s*\d+)*)\]/;

function citeNumbers(body: string): number[] {
  const out: number[] = [];
  for (const part of body.split(/\s*[,;]\s*/)) {
    const r = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (r) { for (let k = Number(r[1]); k <= Number(r[2]) && k - Number(r[1]) <= 20; k++) out.push(k); }
    else out.push(Number(part));
  }
  return out.filter((n) => Number.isInteger(n) && n > 0);
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];
    if (ch === "\n") { flush(); out.push({ t: "br" }); i++; continue; }
    if (ch === "\\" && i + 1 < src.length && /[*_`[\]\\]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", v: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (ch === "[") {
      const m = CITE.exec(rest);
      if (m) { flush(); out.push({ t: "cite", ns: citeNumbers(m[1]) }); i += m[0].length; continue; }
    }
    if (depth < 3 && (rest.startsWith("**") || rest.startsWith("__"))) {
      const mark = rest.slice(0, 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2) { flush(); out.push({ t: "bold", c: parseInline(src.slice(i + 2, end), depth + 1) }); i = end + 2; continue; }
    }
    if (depth < 3 && (ch === "*" || ch === "_")) {
      const end = src.indexOf(ch, i + 1);
      const inner = end > i + 1 ? src.slice(i + 1, end) : "";
      // Emphasis needs a non-space right after the opener and before the closer; `_` must not sit inside a word.
      const prev = i > 0 ? src[i - 1] : " ";
      const after = end + 1 < src.length ? src[end + 1] : " ";
      const wordy = ch === "_" && (/\w/.test(prev) || /\w/.test(after));
      if (inner && !/^\s|\s$/.test(inner) && !inner.includes("\n") && !wordy) {
        flush(); out.push({ t: "em", c: parseInline(inner, depth + 1) }); i = end + 1; continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}
