/**
 * Daily brief: collect the same context as the Today page, number it, and ask mux for a short practical brief with
 * [n] citations. Sensitive items (health, finance, legal) keep the call on local models. Server-only.
 */
import type { Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { getPrefs, tFor, type Locale } from "@/lib/i18n";
import * as mux from "@/lib/mux";
import { peopleContext } from "@/lib/people";
import { templateFor } from "@/lib/templates";
import { loadAssistantBriefInput } from "./assistant";
import { assistantBriefNotes } from "./assistant-home";
import { getCachedBrief, setCachedBrief, type CachedBrief } from "./cache";
import { buildBriefContext, buildBriefMessages, pickCitations } from "./context";
import { appTimeZone, dayKey } from "./dates";
import { loadTodayCore, toBriefInput } from "./today";

export type BriefResult = { text: string; citations: Citation[] };

export class BriefUnavailableError extends Error {
  constructor(message = tFor("en")("today.brief.unavailable")) {
    super(message);
  }
}

/** English text of the brief written when there is nothing to say (see today.brief.nothing for other languages). */
export const NOTHING_TO_BRIEF = tFor("en")("today.brief.nothing");

/** The reader's language and zone; English and the household zone outside a request (scripts, tests). */
async function readerPrefs(): Promise<{ locale: Locale; tz: string }> {
  try {
    const p = await getPrefs();
    return { locale: p.locale, tz: p.timeZone };
  } catch {
    return { locale: "en", tz: appTimeZone() };
  }
}

/**
 * Briefs are per person per graph and per language: a brief written in one graph is never shown in another, and
 * switching language writes a new one.
 */
const briefKey = (v: Pick<Viewer, "id" | "graphId">, locale: Locale) => `${v.id}:${v.graphId}:${locale}`;

/** Today's cached brief for the viewer, if one was written. */
export function cachedBriefFor(v: Pick<Viewer, "id" | "graphId">, now = new Date(), opts: { locale?: Locale; tz?: string } = {}): CachedBrief | null {
  return getCachedBrief(briefKey(v, opts.locale ?? "en"), dayKey(now, opts.tz ?? appTimeZone()));
}

/**
 * Write (or return the cached) brief for today. Throws BriefUnavailableError when mux fails.
 */
export async function generateBrief(v: Viewer, opts: { refresh?: boolean; now?: Date } = {}): Promise<CachedBrief> {
  const now = opts.now ?? new Date();
  const { locale, tz } = await readerPrefs();
  const t = tFor(locale);
  const day = dayKey(now, tz);
  const key = briefKey(v, locale);
  if (!opts.refresh) {
    const hit = getCachedBrief(key, day);
    if (hit) return hit;
  }

  const started = Date.now();
  const [core, assistant] = await Promise.all([loadTodayCore(v, now, tz), loadAssistantBriefInput(v)]);
  const input = toBriefInput(v, core);
  input.locale = locale;
  input.graphKind = v.graphKind ?? "family";
  input.graphNoun = templateFor(v).noun;
  try {
    input.people = await peopleContext(v, [], { now });
  } catch (err) {
    console.error("[briefs] peopleContext failed:", err);
  }
  input.assistant = assistantBriefNotes({ now, tz, ...assistant });
  const ctx = buildBriefContext(input);

  let brief: CachedBrief;
  // People who need attention (low wellbeing, a birthday, no contact for a while) are worth a brief on their own.
  if (ctx.empty && /^Needs attention:/m.test(input.people ?? "")) ctx.empty = false;
  if (ctx.empty && input.assistant?.trim()) ctx.empty = false;
  if (ctx.empty) {
    brief = { text: t("today.brief.nothing"), citations: [], generatedAt: now.toISOString(), day, model: null, local: true };
  } else {
    let res: mux.MuxResult;
    try {
      res = await mux.complete({
        route: ctx.sensitive ? "agent" : "smart",
        messages: buildBriefMessages(input, ctx),
        maxTokens: 400,
        temperature: 0.2,
        meta: { userId: v.id, agent: "my-graph:daily-brief", sensitive: ctx.sensitive || undefined, graphId: v.graphId },
      });
    } catch (err) {
      console.error("[briefs] mux.complete failed:", err);
      throw new BriefUnavailableError(t("today.brief.unavailable"));
    }
    const picked = pickCitations(res.text ?? "", ctx.citations);
    if (!picked.text) throw new BriefUnavailableError(t("today.brief.empty"));
    brief = {
      text: picked.text, citations: picked.citations, generatedAt: new Date().toISOString(), day, model: res.model, local: false,
      durationMs: Date.now() - started,
    };
  }
  setCachedBrief(key, brief);
  return brief;
}
