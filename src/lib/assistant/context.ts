/**
 * The numbered context an answer is written from (pure, unit-tested).
 * Every item the model may cite gets a number [n]; citations in the answer are mapped back to these items.
 */
import type { Citation, Locator } from "@/db/schema";

export type ContextItem =
  | { kind: "passage"; sourceId: string; title: string; text: string; locator: Locator; sensitive: boolean }
  | { kind: "node"; nodeId: string; nodeType: string; title: string; text: string; when: string | null; sensitive: boolean }
  | {
      kind: "fact"; edgeId: string; fromId: string; title: string; status: string; confidence: number;
      sourceId: string | null; sourceTitle: string | null; quote: string | null; locator: Locator; sensitive: boolean;
    }
  | { kind: "reminder"; title: string; due: string; about: string | null; nodeId: string | null; sourceId: string | null; sensitive: boolean };

export type NumberedContext = {
  /** Text for the prompt. */
  text: string;
  /** Citation for each number, in order (index = n - 1). */
  citations: Citation[];
  sensitive: boolean;
  empty: boolean;
};

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** "p2", "0:45–1:10", "chars 120–300" — where in the source. */
export function formatLocator(l: Locator | undefined | null): string {
  if (!l) return "";
  if (typeof l.page === "number") return `p${l.page}`;
  if (typeof l.timeStartSec === "number") {
    const t = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return typeof l.timeEndSec === "number" ? `${t(l.timeStartSec)}–${t(l.timeEndSec)}` : t(l.timeStartSec);
  }
  return "";
}

/** Keep the most useful items under a character budget, without duplicates. */
export function selectItems(items: ContextItem[], opts: { maxItems?: number; maxChars?: number } = {}): ContextItem[] {
  const maxItems = opts.maxItems ?? 30;
  const maxChars = opts.maxChars ?? 14_000;
  const seen = new Set<string>();
  const out: ContextItem[] = [];
  let chars = 0;
  for (const it of items) {
    const key = it.kind === "passage" ? `p:${it.sourceId}:${it.text.slice(0, 80)}`
      : it.kind === "node" ? `n:${it.nodeId}` : it.kind === "fact" ? `f:${it.edgeId}` : `r:${it.title}:${it.due}`;
    if (seen.has(key)) continue;
    const size = it.kind === "passage" ? Math.min(it.text.length, 700) : 200;
    if (out.length >= maxItems || chars + size > maxChars) continue;
    seen.add(key);
    out.push(it);
    chars += size;
  }
  return out;
}

function line(n: number, it: ContextItem): string {
  const tag = it.sensitive ? " (sensitive)" : "";
  switch (it.kind) {
    case "passage": {
      const loc = formatLocator(it.locator);
      return `[${n}] Source: "${clip(it.title, 120)}"${loc ? ` · ${loc}` : ""}${tag}\n    "${clip(it.text, 700)}"`;
    }
    case "node":
      return `[${n}] ${capitalize(it.nodeType)}: ${it.title}${it.when ? ` · ${it.when}` : ""}${tag}${it.text ? `\n    ${clip(it.text, 400)}` : ""}`;
    case "fact": {
      const from = it.sourceTitle ? ` · from "${clip(it.sourceTitle, 80)}"${formatLocator(it.locator) ? ` ${formatLocator(it.locator)}` : ""}` : "";
      const quote = it.quote ? `\n    "${clip(it.quote, 300)}"` : "";
      return `[${n}] Fact: ${it.title} (${it.status}, confidence ${it.confidence.toFixed(2)})${from}${tag}${quote}`;
    }
    case "reminder":
      return `[${n}] Reminder: ${it.title} · due ${it.due}${it.about ? ` · about ${it.about}` : ""}${tag}`;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function citationFor(n: number, it: ContextItem): Citation {
  switch (it.kind) {
    case "passage":
      return { n, sourceId: it.sourceId, title: it.title, quote: clip(it.text, 400), locator: it.locator };
    case "node":
      return { n, nodeId: it.nodeId, title: it.title, quote: it.text ? clip(it.text, 300) : undefined };
    case "fact":
      return {
        n, edgeId: it.edgeId, nodeId: it.fromId, sourceId: it.sourceId ?? undefined, title: it.title,
        quote: it.quote ? clip(it.quote, 400) : undefined, locator: it.locator, confidence: it.confidence,
      };
    case "reminder":
      return { n, nodeId: it.nodeId ?? undefined, sourceId: it.sourceId ?? undefined, title: `Reminder: ${it.title}`, quote: `Due ${it.due}` };
  }
}

export function numberContext(items: ContextItem[]): NumberedContext {
  const lines = items.map((it, i) => line(i + 1, it));
  return {
    text: lines.length ? lines.join("\n") : "(Nothing in the family brain matched this question.)",
    citations: items.map((it, i) => citationFor(i + 1, it)),
    sensitive: items.some((it) => it.sensitive),
    empty: items.length === 0,
  };
}

/** The [n] markers used in an answer, in first-use order (handles [1], [1, 3], [2][4] and [1–3]). */
export function citedNumbers(text: string): number[] {
  const out: number[] = [];
  const push = (n: number) => { if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n); };
  for (const m of text.matchAll(/\[(\d+(?:\s*(?:[,;]|[-–])\s*\d+)*)\]/g)) {
    for (const part of m[1].split(/\s*[,;]\s*/)) {
      const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
      if (range) {
        const a = Number(range[1]); const b = Number(range[2]);
        if (b >= a && b - a <= 20) for (let k = a; k <= b; k++) push(k);
      } else push(Number(part));
    }
  }
  return out;
}

/** The citations an answer actually used (unknown numbers are dropped). */
export function extractCitations(text: string, available: Citation[]): Citation[] {
  const byN = new Map(available.map((c) => [c.n, c]));
  return citedNumbers(text).map((n) => byN.get(n)).filter((c): c is Citation => !!c).sort((a, b) => a.n - b.n);
}
