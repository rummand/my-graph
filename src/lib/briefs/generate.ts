/**
 * Daily brief: collect the same context as the Today page, number it, and ask mux for a short practical brief with
 * [n] citations. Sensitive items (health, finance, legal) keep the call on local models. Server-only.
 */
import type { Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as mux from "@/lib/mux";
import { getCachedBrief, setCachedBrief, type CachedBrief } from "./cache";
import { buildBriefContext, buildBriefMessages, pickCitations } from "./context";
import { appTimeZone, dayKey } from "./dates";
import { loadTodayCore, toBriefInput } from "./today";

export type BriefResult = { text: string; citations: Citation[] };

export class BriefUnavailableError extends Error {
  constructor(message = "The assistant can't be reached right now, so we couldn't write a brief. Everything else on this page still works.") {
    super(message);
  }
}

export const NOTHING_TO_BRIEF = "Nothing on the calendar and no open reminders for the next week. Enjoy the quiet.";

/** Today's cached brief for the viewer, if one was written. */
export function cachedBriefFor(v: Pick<Viewer, "id">, now = new Date()): CachedBrief | null {
  return getCachedBrief(v.id, dayKey(now, appTimeZone()));
}

/**
 * Write (or return the cached) brief for today. Throws BriefUnavailableError when mux fails.
 */
export async function generateBrief(v: Viewer, opts: { refresh?: boolean; now?: Date } = {}): Promise<CachedBrief> {
  const now = opts.now ?? new Date();
  const tz = appTimeZone();
  const day = dayKey(now, tz);
  if (!opts.refresh) {
    const hit = getCachedBrief(v.id, day);
    if (hit) return hit;
  }

  const core = await loadTodayCore(v, now);
  const input = toBriefInput(v, core);
  const ctx = buildBriefContext(input);

  let brief: CachedBrief;
  if (ctx.empty) {
    brief = { text: NOTHING_TO_BRIEF, citations: [], generatedAt: now.toISOString(), day, model: null, local: true };
  } else {
    let res: mux.MuxResult;
    try {
      res = await mux.complete({
        route: ctx.sensitive ? "agent" : "smart",
        messages: buildBriefMessages(input, ctx),
        maxTokens: 400,
        temperature: 0.2,
        meta: { userId: v.id, agent: "my-graph:daily-brief", sensitive: ctx.sensitive || undefined },
      });
    } catch (err) {
      console.error("[briefs] mux.complete failed:", err);
      throw new BriefUnavailableError();
    }
    const picked = pickCitations(res.text ?? "", ctx.citations);
    if (!picked.text) throw new BriefUnavailableError("The assistant returned an empty brief. Please try again.");
    brief = { text: picked.text, citations: picked.citations, generatedAt: new Date().toISOString(), day, model: res.model, local: false };
  }
  setCachedBrief(v.id, brief);
  return brief;
}
