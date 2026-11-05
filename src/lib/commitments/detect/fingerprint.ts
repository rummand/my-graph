/**
 * The de-duplication key of a commitment (pure): kind|counterparty|about|due-day. The same bill read from the email
 * and from its PDF attachment, or the same deadline in a letter and its reminder, lands on the same key. Names are
 * normalised (case, accents, punctuation, "A/S", "ApS"), so "Vejle Kommune" and "VEJLE KOMMUNE" are one party.
 */
import type { CommitmentKind } from "../types";

export function normParty(s: string | null | undefined): string {
  if (!s) return "";
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(a\/s|aps|i\/s|k\/s|p\/s|amba|a\.m\.b\.a\.|ltd|inc|gmbh|as)\b\.?/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function commitmentFingerprint(p: { kind: CommitmentKind | string; counterparty?: string | null; about?: string | null; dueDay?: string | null }): string {
  return [p.kind, normParty(p.counterparty), normParty(p.about), p.dueDay ? p.dueDay.slice(0, 10) : ""].join("|");
}

/** The same commitment at another time: everything but the day. */
export const fingerprintWithoutDay = (fp: string) => fp.split("|").slice(0, 3).join("|");
