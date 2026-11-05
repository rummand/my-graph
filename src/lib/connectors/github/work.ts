/**
 * What the work connectors (GitHub, Linear, Jira) share (pure, no DB): their dependencies, an API that signs with a
 * token or key instead of a sign-in, the settings every one of them has, and handing a batch to the importer.
 *
 * A sync reads newest first, a capped number of items per scope, and hands each scope's batch to importPayload (a
 * library source per batch; its importer proposes one change set). The cursor (the newest `updated` read) moves only
 * after the batch is stored. What a run didn't read is counted in the batch's `leftOut` and said in the proposal.
 */
import { z } from "zod";
import type { Transport } from "@/lib/mcp-client/transport";
import type { WorkBatchInput, WorkProvider } from "@/lib/importers/github/work";
import { needsYou, willRetry } from "../errors";
import { makeApi, type Api, type ApiResponse } from "../oauth/client";
import { sinceField, sinceDay, visibility } from "../oauth/fields";
import type { RunContext } from "../types";

export type WorkDeps = {
  api: Api;
  /** Keep a batch as a library source of `importer`; the importer proposes what matters. */
  importBatch(ctx: RunContext<unknown>, importer: WorkProvider, batch: WorkBatchInput, o: { title: string; externalId: string }): Promise<{ sourceId: string; duplicate: boolean }>;
  base: { github: string; linear: string };
};

/** Settings every work connector has. */
export const workCommon = { visibility, workSince: sinceField, account: z.string().max(320).optional() };

/** The first day to read from: the chosen date, else 90 days back. */
export const firstDay = (cfg: { workSince?: string }, now: Date) => sinceDay(cfg.workSince, now);

/**
 * An API that sends a fixed Authorization header (a personal token or API key). A 401 means the key was refused or
 * revoked: the person has to paste a new one. 403s that say a permission is missing ask the same. Never echoes it.
 */
export function keyApi(o: { transport: Transport; authorization: string; who: string; signal?: AbortSignal; throttle?: () => Promise<void> }): Api {
  const inner = makeApi({
    transport: o.transport, signal: o.signal, throttle: o.throttle, who: o.who,
    token: async () => "", refresh: async () => { throw keyRefused(o.who); },
  });
  return async (req) => {
    const r = await inner({ ...req, noAuth: true, headers: { ...(req.headers ?? {}), authorization: o.authorization } });
    if (r.status === 401) throw keyRefused(o.who);
    return r;
  };
}

export const keyRefused = (who: string) => needsYou(`${who} refused the saved token or key. It may have expired or been revoked; paste a new one.`, "tokenRefused");

/** GitHub and Jira answer 403/429 with a rate limit header when the budget is spent: try again later. */
export function rateLimited(r: ApiResponse, who: string): Error | null {
  const left = r.headers["x-ratelimit-remaining"];
  if ((r.status === 403 || r.status === 429) && (left === "0" || r.headers["retry-after"])) return willRetry(`${who} asked us to slow down for a while.`, "rateLimited");
  return null;
}

/** A description as plain text: no HTML comments (issue templates), no runs of blank lines, shortened. */
export function plainBody(s: string | null | undefined, max = 2000): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Any date string as an ISO instant (Jira writes +0100, not +01:00). */
export function isoOf(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "YYYY-MM-DD" of a date string, or undefined. */
export function dayOf(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return isoOf(s)?.slice(0, 10);
}

/** The newest of some ISO instants (or the fallback). */
export function newest(dates: (string | undefined | null)[], fallback: string): string {
  return dates.reduce<string>((m, d) => (d && d > m ? d : m), fallback);
}

/** Hand one batch to the importer and count it; a batch with nothing in it isn't stored. */
export async function sendBatch(ctx: RunContext<unknown>, d: WorkDeps, stream: string, importer: WorkProvider, batch: WorkBatchInput, o: { title: string; externalId: string }): Promise<void> {
  const empty = !(batch.items?.length) && !(batch.releases?.length) && !(batch.milestones?.length);
  if (empty) return;
  const r = await d.importBatch(ctx, importer, batch, o);
  ctx.count(stream, "fetched", batch.items?.length ?? 0);
  ctx.count(stream, r.duplicate ? "unchanged" : "added");
}
