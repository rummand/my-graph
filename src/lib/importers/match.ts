/**
 * Matching what an importer found against what the graph already knows (pure). Conservative on purpose: a wrong match
 * merges two people, a missed one only proposes a person the reviewer can merge. Email and phone are strong; a name
 * alone matches only when it is unique in the graph and nothing (a birth date) disagrees.
 */
import type { ImportKnown } from "./types";

export const normName = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

export const normEmail = (s: string) => s.trim().toLowerCase();

/** Digits only; Danish numbers compare on their last 8 digits so +45 / 0045 / none all match. */
export function normPhone(s: string): string {
  const d = s.replace(/[^\d]/g, "");
  return d.length >= 8 ? d.slice(-8) : d;
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Emails and phones a known node carries in props (email, emails, phone, phones). */
export function contactsOf(k: ImportKnown): { emails: string[]; phones: string[] } {
  return {
    emails: [...strings(k.props.email), ...strings(k.props.emails)].map(normEmail),
    phones: [...strings(k.props.phone), ...strings(k.props.phones)].map(normPhone).filter(Boolean),
  };
}

/** A birth date the node carries (props.birthDate "YYYY-MM-DD" or birthYear), as "YYYY" or "YYYY-MM-DD". */
function birthOf(k: ImportKnown): string | null {
  if (typeof k.props.birthDate === "string") return k.props.birthDate.slice(0, 10);
  if (typeof k.props.birthYear === "number") return String(k.props.birthYear);
  if (typeof k.props.birthYear === "string" && /^\d{4}$/.test(k.props.birthYear)) return k.props.birthYear;
  return null;
}

function birthsDisagree(a: string | null, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) !== b.slice(0, n);
}

export type PersonClue = { name?: string | null; emails?: string[]; phones?: string[]; birthDate?: string | null };

/** The known person this is, or null. */
export function matchPerson(known: ImportKnown[], clue: PersonClue): ImportKnown | null {
  const people = known.filter((k) => k.type === "person");
  const emails = new Set((clue.emails ?? []).map(normEmail).filter(Boolean));
  const phones = new Set((clue.phones ?? []).map(normPhone).filter((p) => p.length >= 8));
  if (emails.size || phones.size) {
    for (const k of people) {
      const c = contactsOf(k);
      if (c.emails.some((e) => emails.has(e)) || c.phones.some((p) => phones.has(p))) return k;
    }
  }
  if (!clue.name) return null;
  const n = normName(clue.name);
  if (!n) return null;
  const hits = people.filter((k) => normName(k.label) === n || k.aliases.some((a) => normName(a) === n));
  if (hits.length !== 1) return null;
  return birthsDisagree(birthOf(hits[0]), clue.birthDate) ? null : hits[0];
}

/** The known node of this type with this label (or alias), when there is exactly one. */
export function matchByLabel(known: ImportKnown[], type: string, label: string): ImportKnown | null {
  const n = normName(label);
  const hits = known.filter((k) => k.type === type && (normName(k.label) === n || k.aliases.some((a) => normName(a) === n)));
  return hits.length === 1 ? hits[0] : null;
}

/** Same key the ingest pipeline uses for existing edges. */
export const edgeKey = (from: string, relation: string, to: string) => `${from}|${relation}|${to}`;
