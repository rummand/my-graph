/**
 * Reading pass 1, structure (pure, unit-tested): every unit of a rule text, found from the text itself, with where it
 * is. Danish law: "Kapitel 3", "§ 5.", "Stk. 2.", "1)", "a)" and "Bilag 1" (a § inside an annex is "Bilag 1, § 3").
 * EU acts: "CHAPTER II", "Article 6", "1.", "(a)" / "a)", "(i)", recitals "(12)" before the enacting words, "ANNEX I".
 * Anything else: numbered clauses ("3.2") or, failing those, paragraphs under their headings. Each unit also gets its
 * flags (definition, scope, exception, deadline, penalty, commencement, repeal …) and the cross-references in it.
 */
import { hashText } from "@/lib/compliance/text";

export type Family = "dk" | "eu" | "generic";
export type UnitKind = "section" | "chapter" | "heading" | "paragraph" | "stk" | "nr" | "litra" | "article" | "para" | "point" | "subpoint" | "recital" | "annex" | "clause" | "block" | "preamble";
export type Flag = "definition" | "scope" | "exception" | "deadline" | "penalty" | "commencement" | "repeal" | "amendment" | "authorisation" | "purpose";
export type Ref = { ref: string; unitKey?: string; external?: boolean };

export type Unit = {
  key: string; label: string; kind: UnitKind; parentKey: string | null;
  /** The top unit it belongs to ("§ 5", "Art. 6", "Bilag 1, § 3"), what a passage is cut along. */
  top: string;
  chapter: string | null;
  idx: number;
  /** Where the unit is in the text: from its first line to where the next unit at its level (or above) starts. */
  start: number; end: number;
  /** Its own words, before its first sub-unit (what its flags and refs are read from). */
  own: string;
  hash: string;
  flags: Flag[];
  refs: Ref[];
};

/** Units that hold rules (the coverage map counts these); the rest are headings and context. */
export const PROVISION_KINDS: ReadonlySet<UnitKind> = new Set(["paragraph", "stk", "nr", "litra", "article", "para", "point", "subpoint", "clause", "block", "annex"]);
/** The units a passage is cut along, and a re-read is about. */
export const TOP_KINDS: ReadonlySet<UnitKind> = new Set(["paragraph", "article", "clause", "block", "annex"]);

type Line = { text: string; start: number; end: number };

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: pos + lead, end: pos + lead + t.length });
    pos += raw.length + 1;
  }
  return out;
}

const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/;
const isHeadingLine = (t: string, next: string | undefined) => t.length <= 110 && !/[.:;,]$/.test(t) && !/^\(?\d/.test(t) && /^\p{Lu}/u.test(t) && (!next || next.length > t.length * 0.6 || /^(§|Stk\.|Article|Artikel|\d)/.test(next));

type Hit = { kind: UnitKind; level: number; num: string; titleNext?: boolean };

function hitDk(t: string): Hit | null {
  let m: RegExpExecArray | null;
  if ((m = /^Afsnit\s+([IVXLC]+|\d+)\b\.?(\s|$)/.exec(t))) return { kind: "section", level: 0, num: m[1], titleNext: true };
  if ((m = /^Bilag\s+(\d+|[IVXLC]+)\b\.?\s*$/i.exec(t))) return { kind: "annex", level: 0, num: m[1], titleNext: true };
  if ((m = /^Kapitel\s+(\d+\s?[a-z]?)\b\.?(\s|$)/.exec(t))) return { kind: "chapter", level: 1, num: m[1].replace(/\s+/g, " "), titleNext: t.length < 16 };
  if ((m = /^§\s*(\d+(?:\s?[a-z])?)\.?(?=\s|$)/.exec(t))) return { kind: "paragraph", level: 2, num: m[1].replace(/\s+/g, " ") };
  if ((m = /^Stk\.\s*(\d+)\.?(?=\s|$)/.exec(t))) return { kind: "stk", level: 3, num: m[1] };
  if ((m = /^(\d{1,3}(?:\s?[a-z])?)\)\s?(?=\S)/.exec(t))) return { kind: "nr", level: 4, num: m[1].replace(/\s+/g, " ") };
  if ((m = /^([a-zæøå])\)\s?(?=\S)/.exec(t))) return { kind: "litra", level: 5, num: m[1] };
  return null;
}

function hitEu(t: string, inRecitals: boolean, lastPoint: string | null): Hit | null {
  let m: RegExpExecArray | null;
  if ((m = /^(ANNEX|BILAG)(?:\s+([IVXLC]+|\d+))?\s*$/.exec(t))) return { kind: "annex", level: 0, num: m[2] ?? "", titleNext: true };
  if ((m = /^(CHAPTER|KAPITEL|TITLE|AFSNIT)\s+([IVXLC]+|\d+)\s*$/.exec(t))) return { kind: "chapter", level: 1, num: m[2], titleNext: true };
  if ((m = /^(Section|SECTION|Afdeling|AFDELING)\s+(\d+)\s*$/.exec(t))) return { kind: "heading", level: 1.5, num: m[2], titleNext: true };
  if ((m = /^(Article|Artikel)\s+(\d+\s?[a-z]?)\s*$/.exec(t))) return { kind: "article", level: 2, num: m[2].replace(/\s+/g, ""), titleNext: true };
  if (inRecitals && (m = /^\((\d{1,3})\)\s+\S/.exec(t))) return { kind: "recital", level: 2, num: m[1] };
  // Numbered items inside an article ("(1) ‘personal data’ means …", Danish "1) »personoplysninger«: …").
  if (!inRecitals && ((m = /^\((\d{1,3})\)\s+\S/.exec(t)) || (m = /^(\d{1,3})\)\s+\S/.exec(t)))) return { kind: "point", level: 4, num: m[1] };
  if ((m = /^(\d{1,2})\.\s+\S/.exec(t))) return { kind: "para", level: 3, num: m[1] };
  if ((m = /^\(([ivx]+)\)\s+\S/.exec(t)) && ROMAN.test(m[1]) && !(m[1] === "i" && lastPoint === "h") && !(m[1] === "v" && lastPoint === "u") && !(m[1] === "x" && lastPoint === "w")) return { kind: "subpoint", level: 5, num: m[1] };
  if ((m = /^\(([a-z])\)\s+\S/.exec(t)) || (m = /^([a-zæøå])\)\s+\S/.exec(t))) return { kind: "point", level: 4, num: m[1] };
  return null;
}

function hitGeneric(t: string): Hit | null {
  let m: RegExpExecArray | null;
  if ((m = /^(?:Section|Afsnit|Punkt|Clause|Pkt\.)\s+(\d+(?:\.\d+)*)\b/i.exec(t))) return { kind: "clause", level: 2 + (m[1].split(".").length - 1), num: m[1] };
  if ((m = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+\S/.exec(t)) && !/^\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}/.test(t)) return { kind: "clause", level: 2 + (m[1].split(".").length - 1), num: m[1] };
  return null;
}

/** Which kind of text this is, from its lines (many "§ 5." lines → Danish law; "Article 6" lines → EU). */
export function detectFamily(text: string): Family {
  const sample = text.slice(0, 300_000);
  const dk = (sample.match(/^§\s*\d+\s?[a-z]?\.?(\s|$)/gm) ?? []).length + (sample.match(/^Stk\.\s*\d+\./gm) ?? []).length;
  const eu = (sample.match(/^(Article|Artikel)\s+\d+[a-z]?\s*$/gm) ?? []).length;
  if (eu >= 2 && eu >= dk / 2) return "eu";
  if (dk >= 2) return "dk";
  return "generic";
}

const ENACTING = /(HAVE ADOPTED THIS|HAS ADOPTED THIS|HAVE ADOPTED THE|HAS ADOPTED THE|HAR VEDTAGET DENNE|VEDTAGET DENNE|HAR VEDTAGET FØLGENDE|HAS ADOPTED|HAVE ADOPTED)/;

/** Every unit of the text, in order. `family` is detected when not given. */
export function parseUnits(text: string, fam: Family = detectFamily(text)): Unit[] {
  let family = fam;
  const lines = linesOf(text);
  type Open = { unit: Unit; level: number };
  const out: Unit[] = [];
  const stack: Open[] = [];
  let chapter: string | null = null;
  let annexPrefix = "";
  let inRecitals = family === "eu" && ENACTING.test(text);
  let lastPoint: string | null = null;
  let blockN = 0;
  let headingN = 0;
  const keys = new Map<string, number>();
  const famOf = new Map<Unit, Family>();
  const uniq = (k: string) => {
    const n = keys.get(k) ?? 0;
    keys.set(k, n + 1);
    return n ? `${k} (${n + 1})` : k;
  };
  const close = (level: number, at: number) => {
    while (stack.length && stack[stack.length - 1].level >= level) {
      const o = stack.pop()!;
      o.unit.end = at;
    }
  };
  /** The unit a new one sits in: the nearest open unit above its level (headings and chapters don't count). */
  const parentOf = (level: number) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const u = stack[i].unit;
      if (stack[i].level < level && u.kind !== "heading" && u.kind !== "preamble" && u.kind !== "chapter" && u.kind !== "section") return u;
    }
    return null;
  };
  const push = (u: Omit<Unit, "idx" | "hash" | "flags" | "refs" | "own" | "end"> & { end?: number }, level: number) => {
    const unit: Unit = { ...u, end: u.end ?? text.length, idx: out.length, own: "", hash: "", flags: [], refs: [] };
    out.push(unit);
    famOf.set(unit, family);
    stack.push({ unit, level });
    return unit;
  };

  const outer = family;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.text;
    // An annex may be written differently from the act (a Danish law carrying an EU regulation as Bilag 1).
    if (outer === "dk" && /^Bilag\s+(\d+|[IVXLC]+)\b\.?\s*$/i.test(t)) {
      const nextAnnex = lines.slice(i + 1).find((l) => /^Bilag\s+(\d+|[IVXLC]+)\b\.?\s*$/i.test(l.text));
      const seg = text.slice(ln.start, nextAnnex ? nextAnnex.start : text.length);
      const f = detectFamily(seg);
      family = f === "eu" ? "eu" : "dk";
      inRecitals = family === "eu" && ENACTING.test(seg);
      if (family === "eu") {
        close(0, ln.start);
        push({ key: uniq(`Bilag ${/^Bilag\s+(\S+)/i.exec(t)![1]}`), label: t, kind: "annex", parentKey: null, top: "", chapter: null, start: ln.start }, 0);
        const me = out[out.length - 1];
        me.top = me.key;
        annexPrefix = `${me.key}, `;
        chapter = me.key;
        if (lines[i + 1] && lines[i + 1].text.length < 300 && !hitEu(lines[i + 1].text, false, null)) { chapter = `${me.key} ${lines[i + 1].text.slice(0, 120)}`; me.label = chapter; i++; }
        continue;
      }
    }
    if (family === "eu" && inRecitals && ENACTING.test(t)) { close(1, ln.start); inRecitals = false; continue; }
    let hit: Hit | null = family === "dk" ? hitDk(t) : family === "eu" ? hitEu(t, inRecitals, lastPoint) : hitGeneric(t);
    // "(a)" under a numbered definition "(16) ‘main establishment’ means: (a) …" belongs to that number.
    if (hit?.kind === "point" && /^[a-z]$/.test(hit.num) && stack.length && ((stack[stack.length - 1].unit.kind === "point" && /\(\d+\)$/.test(stack[stack.length - 1].unit.key)) || (stack[stack.length - 1].unit.kind === "subpoint" && /\(\d+\)$/.test(stack[stack.length - 1].unit.parentKey ?? "")))) {
      hit = { ...hit, kind: "subpoint", level: 5 };
    }
    if (hit) {
      close(hit.level, ln.start);
      let title = "";
      if (hit.titleNext && lines[i + 1] && !(family === "dk" ? hitDk(lines[i + 1].text) : family === "eu" ? hitEu(lines[i + 1].text, false, null) : hitGeneric(lines[i + 1].text)) && lines[i + 1].text.length < 160) {
        title = lines[i + 1].text;
      }
      const parent = parentOf(hit.level);
      let key: string, label: string, kind = hit.kind;
      switch (hit.kind) {
        case "section": key = `Afsnit ${hit.num}`; label = `${key}${title ? ` ${title}` : ""}`; break;
        case "annex": {
          key = family === "eu" ? `Annex ${hit.num}`.trim() : `Bilag ${hit.num}`;
          if (family === "eu" && /^BILAG/.test(t)) key = `Bilag ${hit.num}`.trim();
          annexPrefix = `${key}, `;
          chapter = `${key}${title ? ` ${title}` : ""}`;
          label = chapter;
          break;
        }
        case "chapter": {
          key = family === "eu" ? `${/^(KAPITEL|AFSNIT)/.test(t) ? "Kapitel" : "Chapter"} ${hit.num}` : `Kapitel ${hit.num}`;
          key = `${annexPrefix}${key}`;
          const inline = family === "dk" && !hit.titleNext ? t.replace(/^Kapitel\s+\S+\.?\s*/, "") : "";
          chapter = `${key.replace(annexPrefix, "")}${title || inline ? ` ${title || inline}` : ""}`;
          if (annexPrefix) chapter = `${annexPrefix.replace(/, $/, "")}: ${chapter}`;
          label = chapter;
          break;
        }
        case "heading": key = `${annexPrefix}${/^(Afdeling|AFDELING)/.test(t) ? "Afdeling" : "Section"} ${hit.num}`; label = `${key}${title ? ` ${title}` : ""}`; break;
        case "paragraph": key = `${annexPrefix}§ ${hit.num}`; label = key; break;
        case "stk": {
          const p = parent && (parent.kind === "paragraph") ? parent.key : `${annexPrefix}§ ?`;
          key = `${p}, stk. ${hit.num}`; label = key; break;
        }
        case "nr": key = `${parent?.key ?? annexPrefix.replace(/, $/, "")}, nr. ${hit.num}`.replace(/^, /, ""); label = key; break;
        case "litra": key = `${parent?.key ?? annexPrefix.replace(/, $/, "")}, litra ${hit.num}`.replace(/^, /, ""); label = key; break;
        case "article": key = `${annexPrefix}Art. ${hit.num}`; label = `${key}${title ? ` ${title}` : ""}`; lastPoint = null; break;
        case "recital": key = `${annexPrefix}${/^\(/.test(t) && /[æøå]|\b(og|af|til|der|som)\b/.test(t) ? "Betragtning" : "Recital"} ${hit.num}`; label = key; break;
        case "para": {
          const art = parentOf(3);
          if (!art || art.kind !== "article") { kind = "block"; key = `${annexPrefix}${hit.num}.`; label = key; break; }
          key = `${art.key}(${hit.num})`; label = key; lastPoint = null; break;
        }
        case "point": key = `${parent?.key ?? (annexPrefix.replace(/, $/, "") || "Point")}(${hit.num})`; label = key; lastPoint = hit.num; break;
        case "subpoint": key = `${parent?.key ?? "Point"}(${hit.num})`; label = key; break;
        case "clause": key = `${annexPrefix}${hit.num}`; label = `${hit.num} ${t.replace(/^\S+\s*/, "").slice(0, 80)}`; break;
        default: key = `${annexPrefix}${hit.num}`; label = key;
      }
      key = uniq(key);
      const topOf = (u: Unit | null): string => {
        let x = u;
        while (x && !TOP_KINDS.has(x.kind)) x = x.parentKey ? out.find((o) => o.key === x!.parentKey) ?? null : null;
        return x?.key ?? key;
      };
      const isStructure = kind === "section" || kind === "chapter" || kind === "heading" || kind === "annex";
      push({ key, label, kind, parentKey: isStructure ? null : parent?.key ?? null, top: "", chapter: kind === "chapter" || kind === "section" ? null : chapter, start: ln.start }, hit.level);
      const me = out[out.length - 1];
      me.top = TOP_KINDS.has(kind) ? key : topOf(parent) || key;
      if (title) i++;
      continue;
    }
    // A line that is no unit: a heading over the next §, a paragraph of a plain text, or the continuation of the
    // unit above (which simply extends to here).
    const next = lines[i + 1]?.text;
    if (family !== "generic" && stack.length && stack[stack.length - 1].unit.kind !== "chapter" && stack[stack.length - 1].unit.kind !== "section" && stack[stack.length - 1].unit.kind !== "annex" && !isHeadingLine(t, next)) continue;
    if (isHeadingLine(t, next) && next && (family !== "generic" || t.length < 80)) {
      close(2, ln.start);
      headingN++;
      push({ key: uniq(`${annexPrefix}Heading ${headingN}`), label: t, kind: out.length || family === "generic" ? "heading" : "preamble", parentKey: null, top: "", chapter, start: ln.start }, 1.8);
      if (family === "generic") chapter = t;
      continue;
    }
    if (family === "generic") {
      close(2, ln.start);
      blockN++;
      const k = uniq(`${annexPrefix}¶ ${blockN}`);
      push({ key: k, label: k, kind: "block", parentKey: null, top: k, chapter, start: ln.start }, 2);
      continue;
    }
    if (!out.length) {
      push({ key: uniq("Preamble"), label: t.slice(0, 120), kind: "preamble", parentKey: null, top: "", chapter: null, start: ln.start }, 1.9);
    }
  }
  close(-1, text.length);

  // Own words, hash, flags, refs.
  for (let i = 0; i < out.length; i++) {
    const u = out[i];
    while (u.end > u.start && /\s/.test(text[u.end - 1])) u.end--;
    const next = out[i + 1];
    const ownEnd = next && next.start < u.end ? next.start : u.end;
    u.own = text.slice(u.start, ownEnd).trim();
    u.hash = hashText(text.slice(u.start, u.end).replace(/\s+/g, " ").trim());
    u.flags = flagsOf(u.own);
    u.refs = refsOf(u.own, u, famOf.get(u) ?? family);
  }
  return out;
}

/* ── Flags ───────────────────────────────────────────────────────────────────────────────────────────────── */

const FLAG_RES: [Flag, RegExp][] = [
  ["definition", /\b(i denne (lov|bekendtgørelse|vejledning|vedtægt|aftale|forordning|cirkulære)[^.]{0,60}forstås|forstås ved|for the purposes of this|[‘'"][^’'"]{2,60}[’'"] means|means any|defineres som|betegnes i denne)\b/i],
  ["scope", /\b(finder anvendelse|gælder (for|ikke|også|endvidere|dog)|omfatter|anvendelsesområde|applies to|shall apply|does not apply|shall not apply|scope)\b/i],
  ["exception", /\b(dog|medmindre|undtagelse\w*|uanset|bortset fra|except|unless|notwithstanding|by way of derogation|undtaget|fravige\w*)\b/i],
  ["deadline", /\b((inden(?: for)?|senest|within|no later than|not later than|efter)\s+(\d+|en|et|to|tre|fire|fem|seks|syv|otte|ni|ti|tolv|one|two|three|four|five|six|seven|eight|ten|twelve|thirty|72)\s+(timer|dage|hverdage|uger|måneder|år|hours|days|working days|weeks|months|years)|frist\w*|time limit|deadline|without undue delay|uden unødigt ophold|straks|immediately)\b/i],
  ["penalty", /\b(straffes|bøde\w*|fængsel|strafansvar|administrative fines?|fines?|penalt\w+|sanktion\w*|imprisonment|tvangsbøde\w*)\b/i],
  ["commencement", /\b(træder i kraft|trådte i kraft|enters? into force|shall enter into force|shall apply from|finder anvendelse fra|har virkning fra)\b/i],
  ["repeal", /\b(ophæves|ophæver|is repealed|are repealed|shall be repealed)\b/i],
  ["amendment", /\b(foretages følgende ændring\w*|affattes således|ændres således|is amended as follows|shall be amended|indsættes som)\b/i],
  ["authorisation", /\b(kan fastsætte (nærmere )?regler|fastsætter (nærmere )?regler|bemyndige\w*|is empowered|delegated acts?|implementing acts?)\b/i],
  ["purpose", /\b(lovens formål|formålet med|has the purpose|purpose of this|aims? to|har til formål)\b/i],
];

export function flagsOf(text: string): Flag[] {
  return FLAG_RES.filter(([, re]) => re.test(text)).map(([f]) => f);
}

/* ── Cross-references ────────────────────────────────────────────────────────────────────────────────────── */

const DK_EXTERNAL = /\b((?:lov|lovbekendtgørelse|bekendtgørelse|cirkulære|vejledning)\s+nr\.\s*\d+\s+af\s+\d{1,2}\.\s*\p{L}+\s+\d{4})/giu;
const EU_EXTERNAL = /\b((?:forordning|direktiv|regulation|directive|beslutning|decision)\s+(?:\((?:EU|EF|EØF|EC|EEC)\)\s*)?(?:nr\.\s*|No\s*)?\d{1,4}\/\d{1,4}(?:\/(?:EU|EF|EØF|EC|EEC))?)/giu;
const NAMED_EXTERNAL = /\b([a-zæøå]+(?:loven|lovens|forordningen|forordningens|bekendtgørelsen|bekendtgørelsens))\s+(§\s*\d+|artikel\s+\d+)/giu;

/**
 * The references a unit makes: to other units of the same text ("§ 12", "§§ 6-8", "stk. 2", "artikel 6, stk. 1",
 * "Article 9(2)") — with the key they point to — and to other acts ("lov nr. 964 af 26. juni 2020", "forordning (EU)
 * 2016/679", "retsplejelovens § 143") as external.
 */
export function refsOf(text: string, unit: Pick<Unit, "key" | "top">, family: Family): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  const add = (r: Ref) => {
    const k = `${r.external ? "x:" : ""}${r.unitKey ?? r.ref}`.toLowerCase();
    if (seen.has(k) || r.unitKey === unit.key || r.unitKey === unit.top) return;
    seen.add(k);
    out.push(r);
  };
  const prefix = /^(Bilag \d+|Annex [IVXLC\d]+), /.exec(unit.key)?.[0] ?? "";
  // External first, and blank them out so "§ 143" in "retsplejelovens § 143" isn't read as this law's § 143.
  let rest = text;
  for (const re of [DK_EXTERNAL, EU_EXTERNAL]) {
    rest = rest.replace(re, (m) => { add({ ref: m.replace(/\s+/g, " ").trim(), external: true }); return " ".repeat(m.length); });
  }
  rest = rest.replace(NAMED_EXTERNAL, (m) => { add({ ref: m.replace(/\s+/g, " ").trim(), external: true }); return " ".repeat(m.length); });
  if (family === "dk" || family === "generic") {
    for (const m of rest.matchAll(/§§\s*(\d+\s?[a-z]?)\s*(?:-|–|til)\s*(\d+\s?[a-z]?)/g)) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (b > a && b - a <= 40) for (let n = a; n <= b; n++) add({ ref: `§ ${n}`, unitKey: `${prefix}§ ${n}` });
    }
    for (const m of rest.matchAll(/(?<!§)§\s*(\d+(?:\s?[a-z](?=[.,;:)]|\s*$|\s+(?:og|eller|stk|nr|til)\b|\s*[-–])(?![a-zæøå]))?)(?:,\s*stk\.\s*(\d+))?(?:,\s*nr\.\s*(\d+))?/g)) {
      const after = rest.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60);
      // "§ 155, stk. 1, i retsplejelov for Færøerne": a paragraph of another act.
      const other = /^([^.;]{0,30}?\b(?:i|in|of)\s+(?:lov\b(?: nr\. \d+)?|[a-zæøå]*lov(?:en|ens)?\b|[a-zæøå]*bekendtgørelse\w*|forordning\w*|direktiv\w*)(?:\s+for\s+\p{Lu}\p{L}+)?)/iu.exec(after);
      if (other) {
        add({ ref: `${m[0]}${other[1]}`.replace(/\s+/g, " ").replace(/[\s,;:]+$/, "").trim().slice(0, 120), external: true });
        continue;
      }
      const p = m[1].replace(/\s+/g, " ");
      const key = `${prefix}§ ${p}${m[2] && m[2] !== "1" ? `, stk. ${m[2]}` : ""}${m[3] ? `${m[2] && m[2] !== "1" ? "" : ""}, nr. ${m[3]}` : ""}`;
      add({ ref: m[0].replace(/\s+/g, " ").trim(), unitKey: key });
    }
    for (const m of rest.matchAll(/(?<![§,]\s?\d*\s?)\bstk\.\s*(\d+)/g)) {
      const head = /^(.*?§ \S+)/.exec(unit.top)?.[1];
      if (head && !/§/.test(rest.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) add({ ref: m[0], unitKey: m[1] === "1" ? head : `${head}, stk. ${m[1]}` });
    }
    for (const m of rest.matchAll(/\bkapitel\s+(\d+\s?[a-z]?)/gi)) add({ ref: m[0], unitKey: `${prefix}Kapitel ${m[1]}` });
  }
  if (family === "eu") {
    for (const m of rest.matchAll(/\b(?:Article|Artikel|artikel)\s+(\d+[a-z]?)(?:\((\d+)\))?(?:\(([a-z])\))?(?:,\s*stk\.\s*(\d+))?(?:,\s*litra\s+([a-z]))?/g)) {
      const para = m[2] ?? m[4];
      const pt = m[3] ?? m[5];
      add({ ref: m[0].trim(), unitKey: `${prefix}Art. ${m[1]}${para ? `(${para})` : ""}${pt ? `(${pt})` : ""}` });
    }
    for (const m of rest.matchAll(/\bArticles?\s+(\d+)\s+(?:to|til)\s+(\d+)/g)) {
      const a = +m[1], b = +m[2];
      if (b > a && b - a <= 40) for (let n = a; n <= b; n++) add({ ref: `Article ${n}`, unitKey: `${prefix}Art. ${n}` });
    }
  } else {
    for (const m of rest.matchAll(/\b(?:artikel|article)\s+(\d+)/gi)) add({ ref: m[0], external: true });
  }
  return out.slice(0, 40);
}

/* ── Looking a reference up ──────────────────────────────────────────────────────────────────────────────── */

/** "§16 Stk 2" → "§ 16, stk. 2"; "Art 6(1)(a)" / "Article 6(1)(a)" / "artikel 6, stk. 1, litra a" → "Art. 6(1)(a)". */
export function normalizeUnitRef(ref: string): string {
  let r = ref.trim().replace(/\s+/g, " ");
  r = r.replace(/^(Article|Artikel|Art\.?)\s*(\d+[a-z]?)/i, "Art. $2");
  r = r.replace(/^(Art\. \d+[a-z]?),?\s*stk\.\s*(\d+)/i, "$1($2)").replace(/,?\s*(?:litra|point)\s*\(?([a-z])\)?/gi, "($1)").replace(/,?\s*nr\.\s*(\d+)(?=\)|$)/gi, (m, n) => (/^Art\./.test(r) ? `(${n})` : m));
  r = r.replace(/§\s*(\d+)\s?([a-z])?(?![a-zæøå])/gi, (_m, n: string, l?: string) => `§ ${n}${l ? ` ${l.toLowerCase()}` : ""}`);
  r = r.replace(/,?\s*stk\.?\s*(\d+)/gi, ", stk. $1").replace(/,?\s*nr\.?\s*(\d+)/gi, ", nr. $1").replace(/,?\s*litra\s*([a-zæøå])/gi, ", litra $1");
  r = r.replace(/\s*,\s*(?=[^\s])/g, ", ").replace(/(Art\. \d+[a-z]?)\s+\(/g, "$1(");
  return r.replace(/[.,;:]+$/, "").trim();
}

/**
 * The unit a reference means: exact, then without ", stk. 1" (the first stykke is the § itself), then the nearest
 * unit above it ("§ 5, stk. 2, nr. 9" in a text that only splits § 5 into stykker → "§ 5, stk. 2"). Null when the text
 * has no such unit.
 */
export function resolveUnit<U extends { key: string }>(ref: string, units: U[], scope?: { prefix?: string }): U | null {
  const byKey = new Map(units.map((u) => [u.key.toLowerCase(), u]));
  let k = normalizeUnitRef(ref);
  if (scope?.prefix && !k.startsWith(scope.prefix)) k = `${scope.prefix}${k}`;
  const tries = [k, k.replace(/, stk\. 1(?=,|$)/, ""), k.replace(/\(1\)$/, "")];
  for (;;) {
    for (const t of tries) { const u = byKey.get(t.toLowerCase()); if (u) return u; }
    const shorter = k.replace(/(, (stk\.|nr\.|litra) [^,]+|\([^()]+\))$/, "");
    if (shorter === k) return null;
    k = shorter;
    tries.splice(0, tries.length, k, k.replace(/, stk\. 1(?=,|$)/, ""));
  }
}
