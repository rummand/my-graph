/**
 * The crawl itself (no database, no network: both are passed in, so it runs on fixtures in tests). From the pasted
 * page it decides what to read and in what order, and hands every document it read to `onDoc`:
 *
 *   Retsinformation  the act's XML (its text, read) and official PDF (the reference of record); the consolidated
 *                    version instead when the pasted act has one; executive orders and guidance issued under it, one
 *                    level out; later amendments and the EU act it implements are named, not read
 *   EUR-Lex          the act's XHTML and PDF/A from the EU Publications Office (eur-lex.europa.eu refuses readers)
 *   a PDF            the PDF itself
 *   any page         the page, its parts or (better) its one-page/print view, its PDFs, guidance one level out
 *
 * Limits: pages, depth, PDFs, linked documents; robots.txt is asked before every fetch. Politeness (one request a
 * second per host) and the SSRF guard live in the fetcher.
 */
import type { SourceRole } from "../pure";
import { describe, classifyUrl, type Description, type Site } from "./classify";
import { celexShortName, cellarUrls, euTitle } from "./eurlex";
import { extractLinks, htmlTitle, htmlToText } from "./html";
import { DEFAULT_LIMITS, isPdfUrl, normalizeUrl, selectLinks, type Limits } from "./links";
import { eliOf, lexDaniaMeta, lexDaniaToText, popularName, relatedFromLinks, relatedFromReferences, retsinfoUrls, type Related } from "./retsinformation";

export type Fetched = { url: string; status: number; type: string; body: Uint8Array };
export type FetchOpts = { accept?: string; language?: string; maxBytes?: number };

export type CrawlDoc = {
  /** Where people open it (the act's page, the EUR-Lex address, the PDF). */
  url: string;
  /** Where its bytes came from (the XML, the Publications Office). */
  fetchedFrom: string;
  format: "html" | "pdf" | "lexdania" | "xhtml" | "text";
  role: SourceRole;
  /** The official PDF of a text that is read from XML/XHTML: kept as the reference of record, not read twice. */
  reference: boolean;
  /** A later amendment: kept and named, its rules are not read (the consolidated text will carry them). */
  amendment?: boolean;
  reason: string; depth: number; title: string; shortName: string | null;
  /** Text for html/xml/xhtml (already turned into plain text); bytes for PDFs. */
  text: string | null; bytes: Uint8Array | null;
  meta: Record<string, unknown>;
};

export type Skipped = { url: string; why: "robots" | "limit" | "failed" | "not_allowed" | "empty" | "not_followed"; detail?: string };

export type CrawlIO = {
  fetch: (url: string, opts?: FetchOpts) => Promise<Fetched>;
  robotsAllow: (url: string) => Promise<boolean>;
  /** Text of a page our own fetch couldn't read (a script-only page): mux's reader. Null when unavailable. */
  readText?: (url: string) => Promise<{ title: string; text: string } | null>;
  onDoc: (doc: CrawlDoc) => Promise<void>;
  onProgress?: (p: CrawlProgress) => Promise<void>;
  /** A document stored earlier is not the text after all (a one-page view replaced it). */
  onDemote?: (url: string, role: SourceRole, reason: string) => Promise<void>;
};

export type CrawlProgress = { fetched: number; pages: number; pdfs: number; skipped: number; current: string | null };

export type CrawlResult = {
  description: Description | null;
  site: Site;
  docs: number; pages: number; pdfs: number;
  skipped: Skipped[];
  /** Named but not read: the EU act a Danish law implements, amendments, links over the limits. */
  related: Related[];
  /** The address the rule set is about (the consolidated act when the pasted one was replaced). */
  mainUrl: string;
};

const td = new TextDecoder("utf-8", { fatal: false });
const textOf = (f: Fetched) => td.decode(f.body);
const isPdf = (f: Fetched) => /application\/pdf/i.test(f.type) || (f.body[0] === 0x25 && f.body[1] === 0x50 && f.body[2] === 0x44 && f.body[3] === 0x46);

export async function crawl(start: string, io: CrawlIO, limits: Limits = DEFAULT_LIMITS): Promise<CrawlResult> {
  const startUrl = normalizeUrl(start) ?? start;
  const site = classifyUrl(startUrl);
  const st = { fetched: 0, pages: 0, pdfs: 0, docs: 0 };
  const skipped: Skipped[] = [];
  const related: Related[] = [];
  const seen = new Set<string>();
  const progress = (current: string | null) => io.onProgress?.({ fetched: st.fetched, pages: st.pages, pdfs: st.pdfs, skipped: skipped.length, current });

  /** One fetch, with robots.txt and the page limit. Null (and a note) when it can't be read. */
  const get = async (url: string, opts?: FetchOpts): Promise<Fetched | null> => {
    if (st.fetched >= limits.maxPages) { skipped.push({ url, why: "limit" }); return null; }
    if (!(await io.robotsAllow(url).catch(() => false))) { skipped.push({ url, why: "robots" }); return null; }
    st.fetched++;
    await progress(url);
    try {
      const f = await io.fetch(url, opts);
      if (f.status < 200 || f.status >= 300) { skipped.push({ url, why: "failed", detail: `HTTP ${f.status}` }); return null; }
      return f;
    } catch (e) {
      skipped.push({ url, why: "failed", detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return null;
    }
  };
  const emit = async (d: CrawlDoc) => {
    st.docs++;
    if (d.format === "pdf") st.pdfs++; else st.pages++;
    await io.onDoc(d);
    await progress(null);
  };

  if (site.site === "retsinformation") return retsinformation(site.eli);
  if (site.site === "eurlex") return eurlex(site.celex, site.lang);
  return web();

  /* ── Retsinformation ──────────────────────────────────────────────────────────────────────────────────── */

  async function retsinformation(startEli: string): Promise<CrawlResult> {
    const readAct = async (eli: string) => {
      const f = await get(retsinfoUrls(eli).xml, { accept: "application/xml" });
      if (!f) return null;
      const xml = textOf(f);
      return { xml, meta: lexDaniaMeta(xml), text: lexDaniaToText(xml) };
    };
    const refsOf = async (docId: string | null) => {
      if (!docId) return { related: [] as Related[], linkLists: [] as { type: number; data: string; header: string }[] };
      const f = await get(retsinfoUrls("").references(docId), { accept: "application/json" });
      try { return f ? relatedFromReferences(JSON.parse(textOf(f))) : { related: [], linkLists: [] }; } catch { return { related: [], linkLists: [] }; }
    };

    const first = await readAct(startEli);
    if (!first || first.text.length < 40) return { description: null, site, docs: 0, pages: 0, pdfs: 0, skipped, related, mainUrl: startUrl };
    let mainEli = startEli;
    let main = first;
    let refs = await refsOf(first.meta.documentId);
    // The pasted act has a current consolidated text: that is what is in force, so it is what is read.
    const consolidated = refs.related.find((r) => r.relation === "consolidated" && !r.historical);
    let replaced: typeof first | null = null;
    if (consolidated) {
      const eli = eliOf(consolidated.url);
      const next = eli ? await readAct(eli) : null;
      if (eli && next && next.text.length >= 40) {
        replaced = first; main = next; mainEli = eli;
        refs = await refsOf(next.meta.documentId);
      }
    }
    const shortOf = (m: typeof first.meta) => m.shortName;
    const description = describe({
      url: retsinfoUrls(mainEli).page, site: { site: "retsinformation", eli: mainEli }, title: main.meta.title ?? "", text: main.text,
      meta: { docType: main.meta.docType, shortName: main.meta.shortName, popular: popularName(main.meta.title), ministry: main.meta.ministry, startDate: main.meta.startDate, status: main.meta.status },
    });
    const actMeta = (m: typeof first.meta, eli: string) => ({ site: "retsinformation", eli, docType: m.docType, number: m.number, documentId: m.documentId, ministry: m.ministry, status: m.status, startDate: m.startDate, signed: m.signed });
    await emit({
      url: retsinfoUrls(mainEli).page, fetchedFrom: retsinfoUrls(mainEli).xml, format: "lexdania", role: "text", reference: false, depth: 0,
      reason: replaced ? "The consolidated text in force (it replaces the act you pasted)" : "The text of the act", title: main.meta.title ?? description.name,
      shortName: shortOf(main.meta), text: main.text, bytes: null, meta: actMeta(main.meta, mainEli),
    });
    const pdf = await get(retsinfoUrls(mainEli).pdf, { accept: "application/pdf", maxBytes: 40 * 1024 * 1024 });
    if (pdf && isPdf(pdf) && st.pdfs < limits.maxPdfs) {
      await emit({
        url: retsinfoUrls(mainEli).pdf, fetchedFrom: retsinfoUrls(mainEli).pdf, format: "pdf", role: "text", reference: true, depth: 0,
        reason: "The official PDF (the reference of record)", title: `${shortOf(main.meta) ?? description.name} (PDF)`, shortName: shortOf(main.meta), text: null, bytes: pdf.body,
        meta: { ...actMeta(main.meta, mainEli), referenceOf: retsinfoUrls(mainEli).page },
      });
    }
    if (replaced) {
      await emit({
        url: retsinfoUrls(startEli).page, fetchedFrom: retsinfoUrls(startEli).xml, format: "lexdania", role: "supporting", reference: false, depth: 1,
        reason: "The act you pasted (its consolidated version is read instead)", title: replaced.meta.title ?? startEli, shortName: shortOf(replaced.meta),
        text: replaced.text, bytes: null, meta: { ...actMeta(replaced.meta, startEli), replacedBy: retsinfoUrls(mainEli).page },
      });
    }
    // Later amendments not yet in the text, and the EU act it implements: named (and the amendments kept), not read.
    for (const r of refs.related) {
      if (r.relation === "eu") { related.push(r); continue; }
      if (r.relation !== "amendment" || r.historical) continue;
      related.push(r);
      const eli = eliOf(r.url);
      const a = eli ? await readAct(eli) : null;
      if (a && eli) {
        await emit({ url: r.url, fetchedFrom: retsinfoUrls(eli).xml, format: "lexdania", role: "supporting", reference: false, amendment: true, depth: 1,
          reason: "A later amendment, not yet in the consolidated text", title: a.meta.title ?? r.title, shortName: shortOf(a.meta), text: a.text, bytes: null, meta: actMeta(a.meta, eli) });
      }
    }
    // Executive orders and guidance issued under it, one level out (current ones first, guidance before orders).
    const linked: Related[] = [];
    for (const l of refs.linkLists) {
      const f = await get(retsinfoUrls("").links(l.type, l.data), { accept: "application/json" });
      if (!f) continue;
      try { linked.push(...relatedFromLinks(JSON.parse(textOf(f)))); } catch { /* not JSON */ }
    }
    const current = linked.filter((r) => !r.historical && r.url !== retsinfoUrls(mainEli).page);
    const picked = [...current.filter((r) => r.relation === "guidance"), ...current.filter((r) => r.relation === "order")].slice(0, limits.maxLinked);
    for (const r of current) if (!picked.includes(r)) { related.push(r); skipped.push({ url: r.url, why: "not_followed", detail: "over the limit of linked documents" }); }
    for (const r of picked) {
      const eli = eliOf(r.url);
      const a = eli ? await readAct(eli) : null;
      if (!a || !eli) continue;
      await emit({
        url: r.url, fetchedFrom: retsinfoUrls(eli).xml, format: "lexdania", role: r.relation === "guidance" ? "interpretation" : "supporting", reference: false, depth: 1,
        reason: r.relation === "guidance" ? "Guidance issued under it" : "An executive order issued under it", title: a.meta.title ?? r.title, shortName: shortOf(a.meta),
        text: a.text, bytes: null, meta: actMeta(a.meta, eli),
      });
    }
    return { description, site, docs: st.docs, pages: st.pages, pdfs: st.pdfs, skipped, related, mainUrl: retsinfoUrls(mainEli).page };
  }

  /* ── EUR-Lex ──────────────────────────────────────────────────────────────────────────────────────────── */

  async function eurlex(celex: string, lang: "da" | "en"): Promise<CrawlResult> {
    const c = cellarUrls(celex, lang);
    const f = await get(c.resource, { accept: c.xhtml.accept, language: c.xhtml.language, maxBytes: 20 * 1024 * 1024 });
    if (!f) return { description: null, site, docs: 0, pages: 0, pdfs: 0, skipped, related, mainUrl: c.eurlex };
    // Official Journal footnotes ("(1) OJ C 34, 2.2.2017, p. 93.") are references, not units of the act.
    const text = htmlToText(textOf(f).replace(/<p\b[^>]*class="[^"]*\boj-note\b[^"]*"[^>]*>[\s\S]*?<\/p>/gi, " ").replace(/<p\b[^>]*class="[^"]*\bnote\b[^"]*"[^>]*>[\s\S]*?<\/p>/gi, " "), { keepChrome: true });
    const t = euTitle(text);
    const description = describe({ url: c.eurlex, site, title: t.title ?? "", text, meta: { popular: t.popular, celex, date: t.date } });
    await emit({ url: c.eurlex, fetchedFrom: f.url, format: "xhtml", role: "text", reference: false, depth: 0, reason: "The text of the act (EU Publications Office)",
      title: t.title ?? celexShortName(celex, lang), shortName: celexShortName(celex, lang), text, bytes: null, meta: { site: "eurlex", celex, lang } });
    const pdf = await get(c.resource, { accept: c.pdf.accept, language: c.pdf.language, maxBytes: 40 * 1024 * 1024 });
    if (pdf && isPdf(pdf)) {
      await emit({ url: c.eurlexPdf, fetchedFrom: pdf.url, format: "pdf", role: "text", reference: true, depth: 0, reason: "The official PDF (the reference of record)",
        title: `${celexShortName(celex, lang)} (PDF)`, shortName: celexShortName(celex, lang), text: null, bytes: pdf.body, meta: { site: "eurlex", celex, lang, referenceOf: c.eurlex } });
    }
    return { description, site, docs: st.docs, pages: st.pages, pdfs: st.pdfs, skipped, related, mainUrl: c.eurlex };
  }

  /* ── Any page (and a single PDF) ──────────────────────────────────────────────────────────────────────── */

  async function web(): Promise<CrawlResult> {
    type Item = { url: string; depth: number; role: SourceRole; reason: string; kind: "start" | "full" | "part" | "pdf" | "linked" };
    const queue: Item[] = [{ url: startUrl, depth: 0, role: "text", reason: "The page you pasted", kind: "start" }];
    seen.add(startUrl);
    let description: Description | null = null;
    let fullRead = false;
    let linkedTaken = 0;
    const startTextLen = { n: 0 };
    while (queue.length) {
      queue.sort((a, b) => order(a) - order(b));
      const it = queue.shift()!;
      if (fullRead && it.kind === "part") { skipped.push({ url: it.url, why: "not_followed", detail: "the whole text was read from its one-page view" }); continue; }
      if (it.kind === "pdf" && st.pdfs >= limits.maxPdfs) { skipped.push({ url: it.url, why: "limit", detail: "PDF limit" }); continue; }
      const f = await get(it.url, { accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5", maxBytes: isPdfUrl(it.url) ? 40 * 1024 * 1024 : 6 * 1024 * 1024 });
      if (!f) continue;
      const finalUrl = normalizeUrl(f.url) ?? f.url;
      seen.add(finalUrl);
      if (isPdf(f)) {
        if (it.kind === "start") description = describe({ url: startUrl, site: { site: "pdf" }, title: decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "").replace(/[-_]+/g, " "), text: "" });
        await emit({ url: finalUrl, fetchedFrom: finalUrl, format: "pdf", role: it.role, reference: false, depth: it.depth, reason: it.kind === "start" ? "The PDF you pasted" : it.reason,
          title: decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? "document.pdf"), shortName: null, text: null, bytes: f.body, meta: { site: "web" } });
        continue;
      }
      const html = textOf(f);
      const isHtml = /html|xml/i.test(f.type) || /<html|<body|<p\b/i.test(html.slice(0, 2000));
      let title = isHtml ? htmlTitle(html) : "";
      let text = isHtml ? htmlToText(html) : html;
      if (text.length < 300 && io.readText) {
        // A page that is only a script (the text is drawn in the browser): mux's reader sees what a person sees.
        const r = await io.readText(finalUrl).catch(() => null);
        if (r && r.text.length > text.length) { text = r.text; title = title || r.title; }
      }
      if (text.trim().length < 40) { skipped.push({ url: finalUrl, why: "empty" }); continue; }
      if (it.kind === "start") {
        startTextLen.n = text.length;
        description = describe({ url: finalUrl, site: classifyUrl(finalUrl), title, text });
      }
      if (it.kind === "full") {
        if (text.length >= startTextLen.n * 0.8) {
          fullRead = true;
          await io.onDemote?.(startUrl, "supporting", "The whole text is read from its one-page view");
        }
      }
      await emit({ url: finalUrl, fetchedFrom: finalUrl, format: "html", role: it.role, reference: false, depth: it.depth, reason: it.reason, title: title || finalUrl, shortName: null, text, bytes: null, meta: { site: "web" } });
      if (!isHtml) continue;
      for (const c of selectLinks({ url: finalUrl, depth: it.depth }, extractLinks(html, finalUrl), { startUrl, visited: seen, limits })) {
        if (seen.has(c.url)) continue;
        if (c.kind === "linked") { if (linkedTaken >= limits.maxLinked) { skipped.push({ url: c.url, why: "limit", detail: "linked documents" }); continue; } linkedTaken++; }
        seen.add(c.url);
        queue.push({ url: c.url, depth: it.depth + 1, role: c.role, reason: c.reason, kind: c.kind });
      }
    }
    return { description, site, docs: st.docs, pages: st.pages, pdfs: st.pdfs, skipped, related, mainUrl: startUrl };
  }
}

/** The start first, then the one-page view, then the document's PDFs, its parts, and the linked documents last. */
function order(it: { kind: string; depth: number }): number {
  const k = { start: 0, full: 1, pdf: 2, part: 3, linked: 4 }[it.kind] ?? 5;
  return k * 10 + it.depth;
}
