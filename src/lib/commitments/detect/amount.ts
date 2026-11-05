/**
 * Money as Danish and English bills write it (pure): "1.234,50 kr.", "kr. 1.234,50", "DKK 4.200", "4.200,- kr",
 * "€ 120.00", "$45", "EUR 1,234.56". Returns the value and an ISO currency.
 */

export type Amount = { value: number; currency: string; text: string; index: number };

const CUR: Record<string, string> = { "kr": "DKK", "kr.": "DKK", "dkk": "DKK", "kroner": "DKK", ",-": "DKK", "€": "EUR", "eur": "EUR", "euro": "EUR", "$": "USD", "usd": "USD", "£": "GBP", "gbp": "GBP", "sek": "SEK", "nok": "NOK" };

/** "1.234,50" (Danish), "1,234.50" (English), "1234", "4.200,-" → a number. */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/\s/g, "").replace(/,-+$/, "").replace(/\.-+$/, "");
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Danish: dots group thousands, the comma is the decimal point (unless three digits follow: "1,234" English thousands).
    const tail = s.slice(lastComma + 1);
    s = tail.length === 3 && lastDot < 0 && !/,\d{3},/.test(s) && s.split(",").length > 2 ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    const tail = s.slice(lastDot + 1);
    // "4.200" is Danish thousands; "120.00" or "45.5" is a decimal point.
    s = tail.length === 3 && lastComma < 0 ? s.replace(/\./g, "") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const NUMBER = String.raw`(\d{1,3}(?:[.\s ]\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)(,-)?`;
const AFTER = String.raw`\s?(kr\.?|dkk|kroner|eur|euro|€|usd|sek|nok|gbp)(?![\p{L}])`;
const BEFORE = String.raw`(kr\.?|dkk|eur|€|\$|usd|£|gbp|sek|nok)\s?`;

/** Every amount with a currency in a text, in order. */
export function amountsIn(text: string): Amount[] {
  const out: Amount[] = [];
  const re = new RegExp(String.raw`(?:${BEFORE}${NUMBER}|${NUMBER}${AFTER}|(\d{1,3}(?:[.\s ]\d{3})+|\d+)(,-))`, "giu");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let cur: string | undefined, num: string | undefined;
    if (m[1] && m[2]) { cur = m[1]; num = m[2] + (m[3] ?? ""); }
    else if (m[4] && m[6]) { num = m[4] + (m[5] ?? ""); cur = m[6]; }
    else if (m[7] && m[8]) { num = m[7]; cur = ",-"; }
    if (!cur || !num) continue;
    const value = parseNumber(num);
    if (value === null || value <= 0 || value > 50_000_000) continue;
    out.push({ value, currency: CUR[cur.toLowerCase()] ?? "DKK", text: m[0].trim(), index: m.index });
  }
  return out;
}

/** "1.234,50 kr." / "DKK 1,234.50" for a label, in the reader's language. */
export function sayAmount(a: { value: number; currency: string }, locale: "en" | "da"): string {
  const whole = Number.isInteger(a.value);
  const n = new Intl.NumberFormat(locale === "da" ? "da-DK" : "en-GB", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(a.value);
  if (a.currency === "DKK") return `${n} kr.`;
  if (a.currency === "EUR") return locale === "da" ? `${n} €` : `€${n}`;
  if (a.currency === "USD") return `$${n}`;
  if (a.currency === "GBP") return `£${n}`;
  return `${n} ${a.currency}`;
}
