/** What the client page and the session page show, in one call each (pages and the API share them). */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { liveJobsFor, type LiveJob } from "@/lib/jobs/queue";
import { sourceReadSql } from "@/lib/gbrain/access";
import { allowed, colleagues, consentViews, loadClient, type ConsentView } from "./access";
import { listItems, type ItemView } from "./items";
import { PURPOSES, type Discipline, type Purpose } from "./pure";
import { consentHistory, listSessions, loadSession, sharedWith, transcriptOf, type ConsentEventView } from "./records";

export type SessionSummary = {
  id: string; kind: string; title: string | null; startsAt: string; status: string; work: string; workError: string | null; hasAudio: boolean; hasTranscript: boolean;
  /** The queued or running job for this session, if any: "waiting" in line or what it is doing now. */
  job: { status: "queued" | "running"; step: string | null; label: string | null; attempts: number } | null;
};

export type ClientPageData = {
  client: { id: string; label: string; kind: string; discipline: Discipline; ownerName: string | null; access: "clinician" | "colleague"; createdAt: string; reason: string | null };
  consent: { state: string; allowed: Record<Purpose, boolean>; reviewAt: string | null };
  consents: ConsentView[];
  consentEvents: ConsentEventView[];
  sharedWith: { id: string; name: string }[];
  colleagues: { id: string; name: string }[];
  sessions: SessionSummary[];
  items: ItemView[];
};

/**
 * Background work runs on the job queue. A "running" with no live job that hasn't moved for 15 minutes was cut off
 * (an old in-process run, or a job that gave up without saying so).
 */
const STALE_MS = 15 * 60_000;
type SessionRowLike = Awaited<ReturnType<typeof listSessions>>[number];
const sessionSummary = (s: SessionRowLike, live: Map<string, LiveJob> = new Map()): SessionSummary => {
  const j = (s.audioSourceId ? live.get(s.audioSourceId) : undefined) ?? (s.transcriptSourceId ? live.get(s.transcriptSourceId) : undefined) ?? null;
  const stale = !j && s.work === "running" && Date.now() - s.updatedAt.getTime() > STALE_MS;
  return {
    id: s.id, kind: s.kind, title: s.title, startsAt: s.startsAt.toISOString(), status: s.status,
    work: j ? "running" : stale ? "failed" : s.work, workError: j ? null : stale ? "interrupted" : s.workError,
    hasAudio: !!s.audioSourceId, hasTranscript: !!s.transcriptSourceId,
    job: j ? { status: j.status, step: j.progress?.step ?? null, label: j.progress?.label ?? null, attempts: j.attempts } : null,
  };
};

/** The live jobs (transcription by its audio, drafting by its transcript) of these sessions. */
async function sessionJobs(rows: SessionRowLike[]): Promise<Map<string, LiveJob>> {
  const ids = rows.flatMap((s) => [s.audioSourceId, s.transcriptSourceId].filter((x): x is string => !!x));
  return ids.length ? liveJobsFor(ids).catch(() => new Map<string, LiveJob>()) : new Map<string, LiveJob>();
}

export async function clientPage(v: Viewer, id: string): Promise<ClientPageData> {
  const rec = await loadClient(v, id);
  const mine = rec.access === "clinician";
  const [consents, events, shared, team, sessions, items] = await Promise.all([
    consentViews(v, rec.id), consentHistory(v, rec.id), mine ? sharedWith(v, rec.id) : Promise.resolve([]),
    mine ? colleagues(v) : Promise.resolve([]), listSessions(v, { clientId: rec.id }), listItems(v, rec),
  ]);
  const live = await sessionJobs(sessions);
  return {
    client: {
      id: rec.id, label: rec.label, kind: rec.kind, discipline: rec.discipline, ownerName: rec.ownerName, access: rec.access, createdAt: rec.createdAt.toISOString(),
      reason: typeof rec.props.referral_reason === "string" ? rec.props.referral_reason : null,
    },
    consent: { state: rec.consent.state, allowed: Object.fromEntries(PURPOSES.map((p) => [p, rec.consent.allowed[p]])) as Record<Purpose, boolean>, reviewAt: rec.consent.reviewAt?.toISOString() ?? null },
    consents, consentEvents: events, sharedWith: shared, colleagues: team.map((c) => ({ id: c.id, name: c.name })),
    sessions: sessions.map((x) => sessionSummary(x, live)), items,
  };
}

export type SessionPageData = {
  session: SessionSummary & { language: string; discipline: Discipline };
  client: ClientPageData["client"];
  consent: ClientPageData["consent"];
  transcript: { text: string; segments: { start: number; end: number; text: string }[] } | null;
  items: ItemView[];
  analysisHidden: boolean;
};

export async function sessionPage(v: Viewer, id: string): Promise<SessionPageData> {
  const { session, client } = await loadSession(v, id);
  const [tr, items, live] = await Promise.all([transcriptOf(session), listItems(v, client, { sessionId: session.id }), sessionJobs([session])]);
  return {
    session: { ...sessionSummary(session, live), language: session.language, discipline: session.discipline as Discipline },
    client: {
      id: client.id, label: client.label, kind: client.kind, discipline: client.discipline, ownerName: client.ownerName, access: client.access,
      createdAt: client.createdAt.toISOString(), reason: typeof client.props.referral_reason === "string" ? client.props.referral_reason : null,
    },
    consent: { state: client.consent.state, allowed: client.consent.allowed, reviewAt: client.consent.reviewAt?.toISOString() ?? null },
    transcript: tr, items, analysisHidden: !allowed(client, "themes"),
  };
}

/** Documents in the practice graph the viewer can open (for the consent form and lab results). Clinical audio and transcripts are left out. */
export async function libraryDocuments(v: Viewer, q?: string): Promise<{ id: string; title: string; mime: string | null; createdAt: string; status: string }[]> {
  const ctx = await accessContext(v);
  const rows = await db.select({ id: sources.id, title: sources.title, mime: sources.mime, createdAt: sources.createdAt, status: sources.status }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), sourceReadSql(ctx, "sources"), inArray(sources.kind, ["upload", "email", "connector", "sync"]),
      sql`coalesce(${sources.meta}->>'clinical', '') <> 'true'`, q ? sql`${sources.title} ilike ${`%${q.replace(/[%_]/g, "")}%`}` : sql`true`))
    .orderBy(desc(sources.createdAt)).limit(50);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
