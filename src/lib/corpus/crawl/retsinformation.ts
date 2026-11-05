/**
 * Retsinformation (pure, unit-tested). The site's pages are a JavaScript app, but every act has its official text as
 * LexDania XML (`<eli>/xml`) and the official PDF (`<eli>/pdf`), and a JSON API names its consolidated version, later
 * amendments and the executive orders and guidance issued under it. This file reads those answers; fetching is in
 * ../crawl/index.ts.
 *
 *   eliOf(url)              "/eli/lta/2023/1081" from any retsinformation address (also /eli/retsinfo/… for guidance)
 *   lexDaniaToText(xml)     the act as plain text: "Kapitel 1", "§ 1. …", "Stk. 2. …", "1) …", "a) …", "Bilag 1"
 *   lexDaniaMeta(xml)       type (LOV, LBK, BEK, VEJ, CIR …), number, title, ministry, dates, status, document id
 *   relatedFromReferences   the consolidated version, later amendments, EU acts it implements
 *   relatedFromLinks        executive orders and guidance listed for it
 */
import { decodeHtml, squash } from "./html";

export const RETSINFO_HOST = /(^|\.)retsinformation\.dk$/i;

/** The ELI path of an act on retsinformation.dk, or null. Accepts /eli/lta/2023/1081, …/xml, …/pdf, /eli/retsinfo/2022/9441. */
export function eliOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!RETSINFO_HOST.test(u.hostname)) return null;
  const m = /^\/eli\/(lta|retsinfo|ft|mt|accn)\/([0-9A-Za-z]+)(?:\/([0-9A-Za-z]+))?/i.exec(u.pathname);
  if (!m) return null;
  return `/eli/${m[1].toLowerCase()}/${m[2]}${m[3] ? `/${m[3]}` : ""}`;
}

export const retsinfoUrls = (eli: string) => ({
  page: `https://www.retsinformation.dk${eli}`,
  xml: `https://www.retsinformation.dk${eli}/xml`,
  pdf: `https://www.retsinformation.dk${eli}/pdf`,
  references: (docId: string | number) => `https://www.retsinformation.dk/api/document/${docId}/references/0`,
  links: (type: number, data: string | number) => `https://www.retsinformation.dk/api/document/documentLinks/${type}/${data}`,
});

/* ── LexDania XML → text ─────────────────────────────────────────────────────────────────────────────────── */

/** Elements whose start begins a new line of the text. */
const BLOCK_OPEN = new Set(["Paragraf", "Stk", "Indentatio", "Index", "Kapitel", "Afsnit", "Bilag", "Rubrica", "ParagrafGruppe", "TekstGruppe", "Titel", "Exitus", "BilagIndhold", "Underafsnit", "AendringCentreretParagraf"]);
/** Elements whose end ends a line. */
const BLOCK_CLOSE = new Set(["Exitus", "Rubrica", "Titel", "Kapitel", "Afsnit", "Paragraf", "Stk", "Indentatio", "Bilag"]);
const SKIP = new Set(["Meta", "UnderskriftGruppe", "Signatur", "Noter", "Fodnote", "SluttekstGruppe"]);

/**
 * The act's text as one block per line pair, in reading order: "Kapitel 3" and its title on their own lines, "§ 5. …"
 * for the first stykke, "Stk. 2. …", "1) …", "a) …". Signatures, metadata and footnotes are left out.
 */
export function lexDaniaToText(xml: string): string {
  const lines: string[] = [];
  let cur = "";
  let explic: string | null = null;
  let skip = 0;
  /** `cur` holds only a label ("§ 5.", "Stk. 2.", "1)") waiting for its text. */
  let labelOnly = false;
  const flush = () => {
    const t = squash(cur);
    if (t) lines.push(t);
    cur = "";
    labelOnly = false;
  };
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[2] !== undefined) {
      const name = m[2].replace(/^.*:/, "");
      if (SKIP.has(name)) { skip = Math.max(0, skip - 1); continue; }
      if (skip) continue;
      if (name === "Explicatus") {
        const e = squash(explic ?? "");
        explic = null;
        if (e) { labelOnly = !cur.trim(); cur = cur.trim() ? `${cur} ${e} ` : `${e} `; }
        continue;
      }
      if (name === "Linea") { cur += " "; continue; }
      if (BLOCK_CLOSE.has(name)) flush();
    } else if (m[3] !== undefined) {
      const name = m[3].replace(/^.*:/, "");
      if (SKIP.has(name)) { if (m[5] !== "/") skip++; continue; }
      if (skip) continue;
      if (name === "Explicatus") { if (m[5] !== "/") explic = ""; continue; }
      // A heading's title goes on its own line after "Kapitel 3"; a stykke's text continues its "§ 5." label.
      if (name === "Rubrica" || name === "Titel") flush();
      else if (BLOCK_OPEN.has(name) && name !== "Exitus" && !labelOnly) flush();
    } else if (m[6] !== undefined) {
      if (skip) continue;
      const t = decodeHtml(m[6]);
      if (!t.trim()) continue;
      if (explic !== null) explic += t;
      else { cur += t; labelOnly = false; }
    } else if (m[1] !== undefined && !skip) {
      cur += m[1];
    }
  }
  flush();
  return lines.join("\n\n");
}

export type LexDaniaMeta = {
  docType: string | null; number: string | null; year: string | null; title: string | null; ministry: string | null;
  signed: string | null; startDate: string | null; status: string | null; documentId: string | null; shortName: string | null;
};

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`).exec(xml);
  return m ? squash(decodeHtml(m[1])) || null : null;
};

/** "BEK H#LOKDOK04" → "BEK", "LOV H" → "LOV", "LBK H" → "LBK". */
export function docTypeCode(raw: string | null): string | null {
  const m = /^([A-ZÆØÅ]{2,4})\b/.exec(raw?.trim() ?? "");
  return m ? m[1] : null;
}

export function lexDaniaMeta(xml: string): LexDaniaMeta {
  const head = xml.slice(0, 20_000);
  const docType = docTypeCode(tag(head, "DocumentType"));
  const number = tag(head, "Number");
  const signed = tag(head, "DiesSigni");
  const date = signed && /^\d{4}-\d{2}-\d{2}$/.test(signed) ? `${signed.slice(8, 10)}/${signed.slice(5, 7)}/${signed.slice(0, 4)}` : null;
  return {
    docType, number, year: tag(head, "Year"), title: tag(head, "DocumentTitle"), ministry: tag(head, "Ministry"), signed,
    startDate: tag(head, "StartDate"), status: tag(head, "Status"), documentId: tag(head, "UniqueDocumentId"),
    shortName: docType && number ? `${docType} nr ${number}${date ? ` af ${date}` : ""}` : null,
  };
}

/** "Lov om … (databeskyttelsesloven)" → "Databeskyttelsesloven". */
export function popularName(title: string | null): string | null {
  const m = /\(([^()]{4,80})\)\s*$/.exec(title ?? "");
  if (!m || /\d{4}\/\d+|nr\.|EU/.test(m[1])) return null;
  return m[1][0].toUpperCase() + m[1].slice(1);
}

/* ── The references API ──────────────────────────────────────────────────────────────────────────────────── */

export type Related = {
  url: string; title: string; shortName: string; docId: number | null;
  /** consolidated: the current consolidated text replaces the start; amendment: a later change; order: an executive
   *  order issued under it; guidance: vejledning/cirkulære; eu: the EU act it implements; incorporated: already in it. */
  relation: "consolidated" | "amendment" | "order" | "guidance" | "eu" | "incorporated";
  historical: boolean;
};

type RefJson = { referenceGroups?: { header?: string; references?: Record<string, unknown>[] }[]; euReferenceGroups?: { references?: Record<string, unknown>[] }[]; documentLinkGroups?: { header?: string; data?: string; type?: number }[] };

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** The related documents named by `/api/document/<id>/references/0`, and which link lists to read next. */
export function relatedFromReferences(raw: unknown): { related: Related[]; linkLists: { type: number; data: string; header: string }[] } {
  const j = (raw && typeof raw === "object" ? raw : {}) as RefJson;
  const related: Related[] = [];
  for (const g of j.referenceGroups ?? []) {
    const h = str(g.header).toLowerCase();
    const relation: Related["relation"] | null = h.startsWith("konsolideret") ? "consolidated" : h.includes("senere ændringer") ? "amendment"
      : h.includes("indarbejdede") ? "incorporated" : null;
    if (!relation) continue;
    for (const r of g.references ?? []) {
      const eli = str(r.eliPath);
      if (!eli.startsWith("/eli/")) continue;
      related.push({ url: `https://www.retsinformation.dk${eli}`, title: str(r.title), shortName: str(r.shortName), docId: typeof r.id === "number" ? r.id : null, relation, historical: r.isHistorical === true });
    }
  }
  for (const g of j.euReferenceGroups ?? []) {
    for (const r of g.references ?? []) {
      const celex = str(r.reference);
      if (/^\d{5}[A-Z]\d{4}/.test(celex)) related.push({ url: `https://eur-lex.europa.eu/legal-content/DA/TXT/?uri=CELEX:${celex}`, title: celex, shortName: `CELEX ${celex}`, docId: null, relation: "eu", historical: false });
    }
  }
  const linkLists = (j.documentLinkGroups ?? [])
    .filter((g) => (g.type === 3 || g.type === 13) && g.data != null)
    .map((g) => ({ type: g.type!, data: String(g.data), header: str(g.header) }));
  return { related, linkLists };
}

/** The executive orders and guidance in a `documentLinks` list (newest current ones first). */
export function relatedFromLinks(raw: unknown): Related[] {
  if (!Array.isArray(raw)) return [];
  const out: Related[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const eli = str(r.eliPath) || str(r.href);
    if (!eli.startsWith("/eli/")) continue;
    const short = str(r.shortName);
    const type = short.split(/\s+/)[0]?.toUpperCase() ?? "";
    out.push({
      url: `https://www.retsinformation.dk${eli}`, title: str(r.title), shortName: short, docId: typeof r.id === "number" ? r.id : null,
      relation: type === "VEJ" || type === "CIR" || type === "CIS" || type === "SKR" ? "guidance" : "order", historical: r.isHistorical === true || r.isHistoric === true,
    });
  }
  return out.sort((a, b) => Number(a.historical) - Number(b.historical));
}
