/**
 * Danish public senders (pure): the authority a letter or a Digital Post notice comes from, under the name people
 * know it by. Conservative: only names that are unmistakably a public body (a kommune, a region, a hospital, a
 * "…styrelsen", Udbetaling Danmark …). Schools only when asked (`schools: true`), because "skole" alone is common.
 */

export type AuthorityKind = "tax" | "benefits" | "municipality" | "region" | "hospital" | "agency" | "police" | "school" | "pension" | "court";

export type Authority = { name: string; kind: AuthorityKind; quote: string; index: number };

const W = String.raw`[A-ZÆØÅ][A-Za-zÆØÅæøåéü-]+`;

type Rule = { re: RegExp; kind: AuthorityKind; name?: string | ((m: RegExpExecArray) => string) };

/** A word boundary that knows Danish letters (JS's \b does not: "Ærø" has none before the Æ). */
const B = String.raw`(?:(?<![\p{L}\p{N}])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?![\p{L}\p{N}]))`;
/** A regex whose \\b knows Danish letters (always with the u flag). */
export const dkRe = (src: string, flags = "") => new RegExp(src.replace(/\\b/g, B), `u${flags}`);

const RULES: Rule[] = [
  { re: dkRe(String.raw`\bSkattestyrelsen\b`), kind: "tax", name: "Skattestyrelsen" },
  { re: dkRe(String.raw`\bSKAT\b`), kind: "tax", name: "Skattestyrelsen" },
  { re: dkRe(String.raw`\bGældsstyrelsen\b`), kind: "tax", name: "Gældsstyrelsen" },
  { re: dkRe(String.raw`\bVurderingsstyrelsen\b`), kind: "tax", name: "Vurderingsstyrelsen" },
  { re: dkRe(String.raw`\bMotorstyrelsen\b`), kind: "tax", name: "Motorstyrelsen" },
  { re: dkRe(String.raw`\bUdbetaling[ ]+Danmark\b`, "i"), kind: "benefits", name: "Udbetaling Danmark" },
  { re: dkRe(String.raw`\bFamilieretshuset\b`), kind: "court", name: "Familieretshuset" },
  { re: dkRe(String.raw`\b(?:Rigspolitiet|Politiet)\b`), kind: "police", name: (m) => m[0] },
  { re: dkRe(String.raw`\b(${W}(?: ${W})?) Politi\b`), kind: "police", name: (m) => `${m[1]} Politi` },
  { re: dkRe(String.raw`\bATP\b`), kind: "pension", name: "ATP" },
  { re: dkRe(String.raw`\bRegion[ ]+(Hovedstaden|Sjælland|Syddanmark|Midtjylland|Nordjylland)\b`), kind: "region", name: (m) => `Region ${m[1]}` },
  { re: dkRe(String.raw`\b(Rigshospitalet|Bispebjerg Hospital|Herlev Hospital|Gentofte Hospital|Hvidovre Hospital|Amager Hospital|Frederiksberg Hospital)\b`), kind: "hospital", name: (m) => m[1] },
  { re: dkRe(String.raw`\b((?:${W} ){0,2}(?:Universitetshospital|Sygehus|Hospital|Regionshospital))\b`), kind: "hospital", name: (m) => m[1].trim() },
  { re: dkRe(String.raw`\b(Styrelsen[ ]+for[ ]+[\p{L}]+(?:[ ]+(?:og|for)[ ]+(?!(?:Region|Styrelsen|Kommune)(?![\p{L}]))[\p{L}]+|[ ]+(?!(?:Region|Styrelsen|Kommune)(?![\p{L}]))\p{Lu}\p{Ll}+)?)`), kind: "agency", name: (m) => m[1].replace(/\s+/g, " ") },
  // "Sundhedsstyrelsen", "Ankestyrelsen", "Lægemiddelstyrelsen" … (Skattestyrelsen and friends are matched above).
  { re: dkRe(String.raw`\b(\p{Lu}\p{Ll}{2,}styrelsen)\b`), kind: "agency", name: (m) => m[1] },
  { re: dkRe(String.raw`\b(${W}(?: ${W})?) Kommune\b`), kind: "municipality", name: (m) => `${m[1]} Kommune` },
];

const SCHOOL: Rule = {
  re: dkRe(String.raw`\b((?:${W} )?${W}(?:skolen|skole)|${W} (?:Skole|Friskole|Privatskole|Efterskole|Gymnasium))\b`),
  kind: "school",
  name: (m) => m[1],
};

/** Words around a kommune name that are not a place ("Din Kommune", "Kontakt Kommune"). */
const NOT_A_PLACE = /^(din|jeres|deres|vores|kontakt|til|fra|den|denne|kære|hej|og|i|af|en|et|brev|afsender)(?= |$)/i;

const MAX_QUOTE = 160;

function lineAround(text: string, index: number, len: number): string {
  const start = Math.max(text.lastIndexOf("\n", index) + 1, index - 60);
  let end = text.indexOf("\n", index + len);
  if (end < 0 || end - index > 100) end = Math.min(text.length, index + len + 60);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE);
}

/** Every authority named in `text`, first mention first, each name once. */
export function findAuthorities(text: string, opts: { schools?: boolean } = {}): Authority[] {
  const found: Authority[] = [];
  const seen = new Set<string>();
  const rules = opts.schools ? [...RULES, SCHOOL] : RULES;
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      let name = typeof rule.name === "function" ? rule.name(m) : rule.name ?? m[0];
      name = name.replace(/\s+/g, " ").trim();
      if (rule.kind === "municipality" && NOT_A_PLACE.test(name)) {
        // "Kontakt Aarhus Kommune": drop the leading word and keep the place.
        const rest = name.split(" ").slice(1).join(" ");
        if (!/^[A-ZÆØÅ]/.test(rest) || rest === "Kommune") continue;
        name = rest;
      }
      if (rule.kind === "hospital" && /^(et|på|til|fra|det|dit|kære|brev|afsender)\s/i.test(name)) name = name.split(" ").slice(1).join(" ");
      if (rule.kind === "hospital" && /^(Hospital|Sygehus|Universitetshospital|Regionshospital)$/.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      // A hospital already named inside a longer name ("Aarhus Universitetshospital") counts once.
      if (found.some((f) => f.kind === rule.kind && (f.name.toLowerCase().includes(key) || key.includes(f.name.toLowerCase())))) continue;
      seen.add(key);
      found.push({ name, kind: rule.kind, quote: lineAround(text, m.index, m[0].length), index: m.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The authority a short phrase names ("Skattestyrelsen", "Aarhus Kommune"), or the phrase itself when it is not one. */
export function authorityFromPhrase(phrase: string): { name: string; kind: AuthorityKind | null } {
  const clean = phrase.replace(/\s+/g, " ").trim();
  const a = findAuthorities(clean, { schools: true })[0];
  return a ? { name: a.name, kind: a.kind } : { name: clean, kind: null };
}
