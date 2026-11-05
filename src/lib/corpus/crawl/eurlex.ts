/**
 * EUR-Lex (pure, unit-tested). eur-lex.europa.eu answers automated readers with an empty "please wait" page, so the
 * official texts are read from the EU Publications Office (publications.europa.eu, the CELLAR repository behind
 * EUR-Lex) by CELEX number: the XHTML for reading and the PDF/A as the reference of record. Both are the same official
 * Journal text EUR-Lex shows.
 *
 *   celexOf(url)   "32016R0679" from eur-lex addresses (?uri=CELEX:…, /eli/reg/2016/679/oj …) and CELLAR addresses
 *   languageOf(url) "da" or "en" (the language the person was reading)
 *   cellarUrls     where the XHTML and PDF are, and the Accept headers that pick them
 *   euTitle(text)  "Regulation (EU) 2016/679 … (General Data Protection Regulation)" from the first lines
 */

export const EURLEX_HOST = /(^|\.)eur-lex\.europa\.eu$/i;
export const CELLAR_HOST = /(^|\.)publications\.europa\.eu$/i;

const ELI_TYPE: Record<string, string> = { reg: "R", reg_impl: "R", reg_del: "R", dir: "L", dir_impl: "L", dir_del: "L", dec: "D", dec_impl: "D", dec_del: "D" };

/** The CELEX number of an EU act from an EUR-Lex or Publications Office address, or null. */
export function celexOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!EURLEX_HOST.test(u.hostname) && !CELLAR_HOST.test(u.hostname)) return null;
  const full = decodeURIComponent(u.toString());
  const c = /CELEX[:%3A]+([0-9][0-9]{4}[A-Z]{1,2}[0-9]{4}(?:\([0-9]+\))?(?:-[0-9]{8})?)/i.exec(full) ?? /\/celex\/([0-9][0-9]{4}[A-Z]{1,2}[0-9]{4}(?:-[0-9]{8})?)/i.exec(u.pathname);
  if (c) return c[1].toUpperCase();
  const e = /\/eli\/(reg|reg_impl|reg_del|dir|dir_impl|dir_del|dec|dec_impl|dec_del)\/(\d{4})\/(\d+)/i.exec(u.pathname);
  if (e) return `3${e[2]}${ELI_TYPE[e[1].toLowerCase()]}${e[3].padStart(4, "0")}`;
  return null;
}

/** The language the address shows the act in: Danish for /DA/ or /dan, English otherwise. */
export function languageOf(url: string): "da" | "en" {
  return /\/(DA|da)\/|\/dan(\/|$)|[?&]locale=da\b/.test(url) ? "da" : "en";
}

export function cellarUrls(celex: string, lang: "da" | "en") {
  const three = lang === "da" ? "dan" : "eng";
  return {
    resource: `http://publications.europa.eu/resource/celex/${celex}`,
    xhtml: { accept: "application/xhtml+xml, text/html;q=0.8", language: three },
    pdf: { accept: "application/pdf;type=pdfa1a", language: three },
    /** The address people know (for links in the app). */
    eurlex: `https://eur-lex.europa.eu/legal-content/${lang.toUpperCase()}/TXT/?uri=CELEX:${celex}`,
    eurlexPdf: `https://eur-lex.europa.eu/legal-content/${lang.toUpperCase()}/TXT/PDF/?uri=CELEX:${celex}`,
  };
}

/** "Regulation (EU) 2016/679" style short name from a CELEX number. */
export function celexShortName(celex: string, lang: "da" | "en"): string {
  const m = /^[0-9](\d{4})([A-Z]{1,2})(\d{4})/.exec(celex);
  if (!m) return celex;
  const num = `${m[1]}/${Number(m[3])}`;
  const type = m[2] === "R" ? (lang === "da" ? "Forordning (EU)" : "Regulation (EU)") : m[2] === "L" ? (lang === "da" ? "Direktiv (EU)" : "Directive (EU)") : m[2] === "D" ? (lang === "da" ? "Afgørelse (EU)" : "Decision (EU)") : "EU act";
  return `${type} ${num}`;
}

/**
 * The act's own title from its first lines: "REGULATION (EU) 2016/679 OF THE EUROPEAN PARLIAMENT … of 27 April 2016 on …
 * (General Data Protection Regulation)". Returns the full title and the popular name in brackets, when there is one.
 */
export function euTitle(text: string): { title: string | null; popular: string | null; date: string | null } {
  const head = text.slice(0, 4000).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const i = head.findIndex((l) => /^(REGULATION|DIRECTIVE|DECISION|COMMISSION|EUROPA-PARLAMENTETS|RÅDETS|KOMMISSIONENS|FORORDNING|DIREKTIV)\b/.test(l) && l === l.toUpperCase());
  if (i < 0) return { title: null, popular: null, date: null };
  const caps = head[i];
  const parts = [caps[0] + caps.slice(1).toLowerCase().replace(/\(eu\)/g, "(EU)").replace(/\(ef\)/g, "(EF)").replace(/\(ec\)/g, "(EC)")
    .replace(/\b(european|parliament|council|commission|europa-parlamentets|rådets|kommissionens)\b/g, (w) => w[0].toUpperCase() + w.slice(1))];
  let date: string | null = null;
  for (const l of head.slice(i + 1, i + 4)) {
    if (/^(of|af) \d{1,2}\.? \w+ \d{4}$/i.test(l)) { date = l.replace(/^(of|af) /i, ""); parts.push(l); continue; }
    if (/^(on|om) /i.test(l)) { parts.push(l); break; }
  }
  const title = parts.join(" ").replace(/\s+/g, " ");
  const pop = /\(([^()]{6,90})\)\s*$/.exec(title)?.[1] ?? null;
  return { title, popular: pop && !/text with eea|eøs-relevant/i.test(pop) ? pop : null, date };
}
