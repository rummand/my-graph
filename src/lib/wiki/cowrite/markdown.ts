/**
 * Co-writing: the bridge between a wiki page (TipTap JSON) and the small markdown the assistant writes. Pure and
 * client-safe.
 *
 *   docToMarkdown     page → markdown, so the assistant sees headings, lists and checklists (mentions as @Name,
 *                     page links as [[Title]])
 *   markdownToBlocks  the assistant's markdown → TipTap blocks. Citation markers [S1] become cobalt links to the
 *                     source (/library/<id> or /node/<id>); @Name and [[Title]] become mentions and page links again
 *                     when they match ones the page already had. Works on a half-written stream too.
 */
import { safeHref, type DocMark, type DocNode } from "../doc";

/** What the assistant may cite: numbered as S1, S2 … in the prompt. */
export type CiteTarget = { n: number; kind: "source" | "node" | "page"; id: string; title: string; slug?: string | null };

export type KnownRefs = {
  mentions?: { id: string; label: string; nodeType: string | null }[];
  pages?: { id: string; label: string; slug: string | null }[];
};

export const citeHref = (c: Pick<CiteTarget, "kind" | "id" | "slug">) =>
  c.kind === "page" && c.slug ? `/wiki/${encodeURIComponent(c.slug)}` : c.kind === "node" ? `/node/${c.id}` : `/library/${c.id}`;

/** The short label shown on a citation inside the page. */
export function citeLabel(title: string): string {
  const t = title.replace(/\.(txt|pdf|jpe?g|png|heic|webp|docx?|m4a|mp3|wav|eml)$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Source";
  return t.length > 28 ? `${t.slice(0, 26).trimEnd()}…` : t;
}

/** True for the links co-writing inserts as citations (styled as chips in the editor and the read view). */
export function isCitationHref(href: string | null | undefined): boolean {
  return !!href && (/^\/(library|node)\/[0-9a-f-]{36}$/i.test(href) || /^\/wiki\/[a-z0-9-]{1,120}$/.test(href));
}

/* ── Page → markdown ───────────────────────────────────────────────────────────────────────────────────── */

function inlineMd(nodes: DocNode[] | undefined): string {
  return (nodes ?? []).map((n) => {
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") return `@${String(n.attrs?.label ?? "")}`;
    if (n.type === "pageLink") return `[[${String(n.attrs?.label ?? "")}]]`;
    if (n.type !== "text") return inlineMd(n.content);
    let t = n.text ?? "";
    const marks = new Set((n.marks ?? []).map((m) => m.type));
    if (marks.has("code")) t = `\`${t}\``;
    if (marks.has("bold")) t = `**${t}**`;
    if (marks.has("italic")) t = `*${t}*`;
    const link = n.marks?.find((m) => m.type === "link");
    if (link && typeof link.attrs?.href === "string") t = `[${t}](${link.attrs.href})`;
    return t;
  }).join("");
}

function blockMd(n: DocNode, indent: string): string[] {
  switch (n.type) {
    case "paragraph": return [indent + inlineMd(n.content)];
    case "heading": return [`${"#".repeat(Math.min(Math.max(Number(n.attrs?.level) || 2, 1), 4))} ${inlineMd(n.content)}`];
    case "horizontalRule": return ["---"];
    case "codeBlock": return ["```", ...(n.content ?? []).map((c) => c.text ?? "").join("").split("\n"), "```"];
    case "blockquote": return (n.content ?? []).flatMap((c) => blockMd(c, "")).map((l) => `> ${l}`);
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const start = Number(n.attrs?.start) || 1;
      return (n.content ?? []).flatMap((item, i) => {
        const bullet = n.type === "orderedList" ? `${start + i}. ` : n.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}] ` : "- ";
        const [first, ...rest] = item.content ?? [];
        const head = first && (first.type === "paragraph" || first.type === "heading") ? inlineMd(first.content) : "";
        const tail = (first && head === "" ? [first, ...rest] : rest).flatMap((c) => blockMd(c, indent + "  "));
        return [indent + bullet + head, ...tail];
      });
    }
    default: return n.content ? n.content.flatMap((c) => blockMd(c, indent)) : [];
  }
}

export function docToMarkdown(doc: DocNode): string {
  return (doc.content ?? []).map((b) => blockMd(b, "").join("\n")).filter((s) => s.trim()).join("\n\n");
}

/* ── Markdown → blocks ─────────────────────────────────────────────────────────────────────────────────── */

type Ctx = { cites: Map<number, CiteTarget>; mentions: NonNullable<KnownRefs["mentions"]>; pages: NonNullable<KnownRefs["pages"]>; used: Set<number> };

const text = (t: string, marks?: DocMark[]): DocNode => (marks?.length ? { type: "text", text: t, marks } : { type: "text", text: t });

/** Inline markdown → TipTap inline nodes. */
export function parseInlineMd(src: string, ctx: Ctx, marks: DocMark[] = []): DocNode[] {
  const out: DocNode[] = [];
  let buf = "";
  const flush = () => { if (buf) out.push(text(buf, marks)); buf = ""; };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    // Citations: [S1] / [S1, S3] / [S1][S2]
    const cite = /^\[\s*(S?\d{1,3}(?:\s*[,;]\s*S?\d{1,3})*)\s*\]/i.exec(rest);
    if (cite && /S/i.test(cite[1])) {
      const ns = cite[1].split(/[,;]/).map((s) => Number(s.trim().replace(/^S/i, ""))).filter((n) => ctx.cites.has(n));
      if (ns.length) {
        flush();
        if (out.length && !/\s$/.test(String(out[out.length - 1].text ?? " "))) out.push(text(" ", marks));
        ns.forEach((n, k) => {
          const c = ctx.cites.get(n)!;
          ctx.used.add(n);
          if (k) out.push(text(" ", marks));
          // Another wiki page is cited as a [[page link]]; anything else as a cobalt citation link.
          out.push(c.kind === "page"
            ? { type: "pageLink", attrs: { id: c.id, label: c.title, slug: c.slug ?? null } }
            : text(citeLabel(c.title), [{ type: "link", attrs: { href: citeHref(c) } }]));
        });
      }
      i += cite[0].length;
      continue;
    }
    // [[Page title]]
    const page = /^\[\[([^\]\n]{1,200})\]\]/.exec(rest);
    if (page) {
      const label = page[1].trim();
      const known = ctx.pages.find((p) => p.label.toLowerCase() === label.toLowerCase());
      flush();
      out.push(known ? { type: "pageLink", attrs: { id: known.id, label: known.label, slug: known.slug } } : text(label, marks));
      i += page[0].length;
      continue;
    }
    // [text](href)
    const link = /^\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/.exec(rest);
    if (link) {
      flush();
      const href = safeHref(link[2]);
      out.push(...parseInlineMd(link[1], ctx, href ? [...marks, { type: "link", attrs: { href } }] : marks));
      i += link[0].length;
      continue;
    }
    // @Name, when the page already mentions that name (longest match first)
    if (src[i] === "@" && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const m = [...ctx.mentions].sort((a, b) => b.label.length - a.label.length)
        .find((x) => x.label && rest.slice(1, x.label.length + 1).toLowerCase() === x.label.toLowerCase() && !/[\p{L}\p{N}]/u.test(rest[x.label.length + 1] ?? ""));
      if (m) {
        flush();
        out.push({ type: "mention", attrs: { id: m.id, label: m.label, nodeType: m.nodeType } });
        i += m.label.length + 1;
        continue;
      }
    }
    // `code`
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) { flush(); out.push(text(code[1], [...marks, { type: "code" }])); i += code[0].length; continue; }
    // **bold** / __bold__
    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold) { flush(); out.push(...parseInlineMd(bold[2], ctx, [...marks, { type: "bold" }])); i += bold[0].length; continue; }
    // *italic* / _italic_ (an underscore only at a word boundary, so snake_case stays text)
    const em = /^\*(?=\S)([^*\n]*?\S)\*/.exec(rest) ?? (i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1]) ? /^_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/u.exec(rest) : null);
    if (em) { flush(); out.push(...parseInlineMd(em[1], ctx, [...marks, { type: "italic" }])); i += em[0].length; continue; }
    buf += src[i];
    i++;
  }
  flush();
  // Merge neighbouring text nodes with the same marks.
  const merged: DocNode[] = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && n.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) last.text += n.text ?? "";
    else merged.push({ ...n });
  }
  return merged.filter((n) => n.type !== "text" || (n.text ?? "") !== "");
}

const BULLET = /^(\s*)[-*•+]\s+(.*)$/;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}```/;

type ListKind = "bulletList" | "orderedList" | "taskList";
type ListLine = { kind: ListKind; indent: number; text: string; checked?: boolean; start?: number };

function listLine(line: string): ListLine | null {
  let m = TASK.exec(line);
  if (m) return { kind: "taskList", indent: m[1].length, text: m[3], checked: m[2].toLowerCase() === "x" };
  m = ORDERED.exec(line);
  if (m) return { kind: "orderedList", indent: m[1].length, text: m[3], start: Number(m[2]) };
  m = BULLET.exec(line);
  if (m && !RULE.test(line)) return { kind: "bulletList", indent: m[1].length, text: m[2] };
  return null;
}

function para(src: string, ctx: Ctx): DocNode {
  const content = parseInlineMd(src, ctx);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

/** Build nested lists from consecutive list lines (deeper indentation nests under the previous item). */
function buildList(lines: ListLine[], ctx: Ctx): DocNode[] {
  const out: DocNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const base = lines[i];
    const list: DocNode = { type: base.kind, content: [] };
    if (base.kind === "orderedList") list.attrs = { start: base.start ?? 1 };
    while (i < lines.length && lines[i].indent <= base.indent && lines[i].kind === base.kind) {
      const l = lines[i];
      const item: DocNode = { type: base.kind === "taskList" ? "taskItem" : "listItem", content: [para(l.text, ctx)] };
      if (base.kind === "taskList") item.attrs = { checked: !!l.checked };
      i++;
      const kids: ListLine[] = [];
      while (i < lines.length && lines[i].indent > base.indent) kids.push(lines[i++]);
      if (kids.length) item.content!.push(...buildList(kids, ctx));
      list.content!.push(item);
    }
    if (list.content!.length) out.push(list);
    else i++; // a deeper line with no parent: skip safely
  }
  return out;
}

export type ParsedDraft = { blocks: DocNode[]; cited: number[] };

/**
 * The assistant's markdown as TipTap blocks. `final: false` while streaming: a half-typed citation or link at the
 * very end is held back until it is complete, so it doesn't flash as raw brackets.
 */
export function markdownToBlocks(md: string, opts: { cites?: CiteTarget[]; refs?: KnownRefs; final?: boolean } = {}): ParsedDraft {
  const ctx: Ctx = {
    cites: new Map((opts.cites ?? []).map((c) => [c.n, c])), mentions: opts.refs?.mentions ?? [], pages: opts.refs?.pages ?? [], used: new Set(),
  };
  let src = md.replace(/\r\n?/g, "\n").replace(/^\s*<think>[\s\S]*?(<\/think>\s*|$)/i, "");
  // Models sometimes wrap the whole answer in a ```markdown fence.
  src = src.replace(/^\s*```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "");
  if (!opts.final) src = src.replace(/\[[^\]\n]{0,40}$/, "").replace(/\*{1,2}$/, "");
  const lines = src.split("\n");
  const blocks: DocNode[] = [];
  let paraLines: string[] = [];
  let listLines: ListLine[] = [];
  const endPara = () => { if (paraLines.length) blocks.push(para(paraLines.join(" ").replace(/\s+/g, " ").trim(), ctx)); paraLines = []; };
  const endList = () => { if (listLines.length) blocks.push(...buildList(listLines, ctx)); listLines = []; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      endPara(); endList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      const t = code.join("\n");
      blocks.push(t ? { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: t }] } : { type: "codeBlock", attrs: { language: null } });
      continue;
    }
    if (!line.trim()) { endPara(); if (listLines.length && !listLine(lines[i + 1] ?? "")) endList(); continue; }
    const h = HEADING.exec(line);
    if (h) {
      endPara(); endList();
      const content = parseInlineMd(h[2], ctx);
      blocks.push({ type: "heading", attrs: { level: h[1].length <= 2 ? 2 : 3 }, ...(content.length ? { content } : {}) });
      continue;
    }
    if (RULE.test(line)) { endPara(); endList(); blocks.push({ type: "horizontalRule" }); continue; }
    const li = listLine(line);
    if (li) {
      endPara();
      if (listLines.length && li.indent <= listLines[0].indent && li.kind !== listLines[0].kind) endList();
      listLines.push(li);
      continue;
    }
    if (listLines.length && /^\s{2,}\S/.test(line)) { listLines[listLines.length - 1].text += " " + line.trim(); continue; }
    const q = QUOTE.exec(line);
    if (q) {
      endPara(); endList();
      const quoted: string[] = [q[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) quoted.push(QUOTE.exec(lines[++i])![1]);
      blocks.push({ type: "blockquote", content: [para(quoted.join(" ").trim(), ctx)] });
      continue;
    }
    endList();
    paraLines.push(line.trim());
  }
  endPara(); endList();
  return { blocks: blocks.filter((b) => b.type !== "paragraph" || b.content?.length), cited: [...ctx.used].sort((a, b) => a - b) };
}

/** Words in a set of blocks (for "The assistant wrote 140 words"). */
export function wordCount(blocks: DocNode[]): number {
  let n = 0;
  const walk = (x: DocNode) => {
    if (x.type === "text") {
      const cite = x.marks?.some((m) => m.type === "link" && isCitationHref(String(m.attrs?.href ?? "")));
      if (!cite) n += (x.text ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    }
    else if (x.type === "mention" || x.type === "pageLink") n += 1;
    x.content?.forEach(walk);
  };
  blocks.forEach(walk);
  return n;
}

const tokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}:.'’-]*[\p{L}\p{N}]|\p{N}/gu) ?? []);

/**
 * Words and numbers in the draft that the page didn't already have (names, times, places …). Used to tell whether
 * an uncited draft could carry anything from the items it read, or only rearranges the page's own text.
 */
export function newTerms(draftBlocks: DocNode[], pageMarkdown: string): string[] {
  const have = tokens(pageMarkdown);
  const words: string[] = [];
  const walk = (x: DocNode) => {
    if (x.type === "text" && !x.marks?.some((m) => m.type === "link" && isCitationHref(String(m.attrs?.href ?? "")))) words.push(x.text ?? "");
    x.content?.forEach(walk);
  };
  draftBlocks.forEach(walk);
  return [...tokens(words.join(" "))].filter((w) => !have.has(w) && (w.length >= 4 || /\d/.test(w)));
}
