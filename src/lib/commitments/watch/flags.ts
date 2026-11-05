/**
 * What the ledger and Today read from the watch (server-only, read-only — nothing here writes or proposes):
 *
 *   contradictionFlags(v, list)  advisory flags per commitment: two sources (or a rule and a source) that disagree,
 *                                with both quotes and a plain sentence in the reader's language
 *   progressSignals(v, list)     the newest related message/document since each commitment appeared (feeds at-risk)
 *   morningLine(v)               one sentence for Today and notifications ("3 things this week, 1 at risk: …")
 *
 * Computed on read as the viewer (so a flag never quotes a source they couldn't open), cached briefly per viewer.
 */
import type { Viewer } from "@/lib/auth";
import { localeOf } from "@/lib/assistant/locale";
import { DEFAULT_TZ, urgencyOf, type CommitmentView } from "../pure";
import { loadCommitments } from "../store";
import { explainContradiction, findContradictions, type Contradiction } from "./contradict";
import { latestRelatedSource, ownSourcesOf, partiesFor, rulesFor, statementsFor } from "./load";
import { withSignal, type ProgressSignal } from "./risk";
import { morningSummary, type SummaryLocale } from "./summary";

export type CommitmentFlag = {
  key: string;
  kind: "contradiction";
  field: Contradiction["field"];
  /** The plain sentence, in the reader's language. */
  text: string;
  a: { sourceId: string | null; ruleId: string | null; title: string; quote: string; href: string | null };
  b: { sourceId: string | null; ruleId: string | null; title: string; quote: string; href: string | null };
  /** The side that carries more weight (null: a person has to check). */
  winner: "a" | "b" | null;
  /** A fix is (or will be) proposed by the watch: deliver it from Changes. */
  fixable: boolean;
};

const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value as T);
  return fn().then((value) => {
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

const side = (c: Contradiction["a"]): CommitmentFlag["a"] => {
  const real = !c.sourceId.startsWith("rule:");
  return { sourceId: real ? c.sourceId : null, ruleId: c.ruleId ?? null, title: c.ruleRef ? `${c.title} (${c.ruleRef})` : c.title, quote: c.quote, href: real ? `/library/${c.sourceId}` : null };
};

/** Advisory flags for open commitments (only the ones with a kind where contradictions are read). */
export async function contradictionFlags(v: Viewer, list: CommitmentView[], opts: { locale?: SummaryLocale } = {}): Promise<Record<string, CommitmentFlag[]>> {
  const open = list.filter((c) => c.props.status === "open" && ["notice", "reply", "form", "renewal", "payment"].includes(c.props.kind)).slice(0, 60);
  if (!open.length) return {};
  const locale = opts.locale ?? ((await localeOf(v.id)) as SummaryLocale);
  const key = `flags:${v.graphId}:${v.id}:${locale}:${open.map((c) => `${c.id}@${c.updatedAt}`).join(",")}`;
  return cached(key, async () => {
    const own = await ownSourcesOf(v, open);
    const parties = await partiesFor(v, open, own, { wide: true });
    const out: Record<string, CommitmentFlag[]> = {};
    for (const c of open) {
      const o = own.get(c.id) ?? { ids: [], threadKeys: [], firstAt: null };
      const party = parties.get(c.id) ?? [];
      const st = await statementsFor(v, c, o, party);
      if (!st.length) continue;
      const rules = await rulesFor(v, c, st);
      const found = findContradictions({ id: c.id, kind: c.props.kind, dueAt: c.props.dueAt, amount: c.props.amount ?? null }, [...st, ...rules], DEFAULT_TZ);
      if (!found.length) continue;
      out[c.id] = found.map((x) => ({
        key: x.key, kind: "contradiction", field: x.field, text: explainContradiction(x, locale), a: side(x.a), b: side(x.b),
        winner: x.winner ? (x.winner === x.a ? "a" : "b") : null, fixable: !!x.fix,
      }));
    }
    return out;
  });
}

/** Progress signals per commitment: the newest related source after it appeared (null when there is none). */
export async function progressSignals(v: Viewer, list: CommitmentView[]): Promise<Record<string, ProgressSignal>> {
  const open = list.filter((c) => c.props.status === "open" && c.props.dueAt).slice(0, 80);
  if (!open.length) return {};
  const key = `signals:${v.graphId}:${v.id}:${open.map((c) => `${c.id}@${c.updatedAt}`).join(",")}`;
  return cached(key, async () => {
    const own = await ownSourcesOf(v, open);
    const parties = await partiesFor(v, open, own, { wide: true });
    const out: Record<string, ProgressSignal> = {};
    for (const c of open) {
      const o = own.get(c.id) ?? { ids: [], threadKeys: [], firstAt: null };
      const party = parties.get(c.id) ?? [];
      const s = await latestRelatedSource(v, c, o, party, new Date(c.createdAt));
      out[c.id] = s ? { at: new Date(s.at).toISOString(), what: s.title, sourceId: s.id } : { at: null };
    }
    return out;
  });
}

/** Commitments with the graph's progress signals folded into their props (so `urgencyOf` sees them). */
export async function withProgress(v: Viewer, list: CommitmentView[]): Promise<CommitmentView[]> {
  const signals = await progressSignals(v, list);
  return list.map((c) => (signals[c.id]?.at ? { ...c, props: withSignal(c.props, c.createdAt, signals[c.id]) } : c));
}

/**
 * The morning line for the viewer in their language. A template; with COMMITMENTS_SUMMARY_POLISH=1 a fast model may
 * smooth the wording (never for sensitive commitments, and it falls back to the template on any failure).
 */
export async function morningLine(v: Viewer, opts: { now?: Date; tz?: string; list?: CommitmentView[] } = {}): Promise<string> {
  const now = opts.now ?? new Date(), tz = opts.tz ?? DEFAULT_TZ;
  const locale = (await localeOf(v.id)) as SummaryLocale;
  const list = await withProgress(v, opts.list ?? await loadCommitments(v, { status: ["open"] }));
  const items = list.map((c) => ({ label: c.label, dueAt: c.props.dueAt, urgency: urgencyOf(c.props, now, tz), kind: c.props.kind }));
  const line = morningSummary(items, locale, now, tz);
  if (process.env.COMMITMENTS_SUMMARY_POLISH !== "1" || list.some((c) => c.sensitive)) return line;
  return polish(v, line, locale).catch(() => line);
}

async function polish(v: Viewer, line: string, locale: SummaryLocale): Promise<string> {
  const mux = await import("@/lib/mux");
  const r = await mux.complete({
    route: "fast", maxTokens: 120, temperature: 0.2,
    meta: { userId: v.id, agent: "commitments-summary", graphId: v.graphId, sensitive: true },
    messages: [
      { role: "system", content: `Rewrite the sentence so it reads naturally in ${locale === "da" ? "Danish" : "English"}. Keep every number, name and day. One sentence, no additions.` },
      { role: "user", content: line },
    ],
  });
  const out = r.text.trim().replace(/^["“„]|["”“]$/g, "");
  return out && out.length < 300 ? out : line;
}
