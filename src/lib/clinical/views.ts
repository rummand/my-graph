/** What the client page and the session page show, in one call each (pages and the API share them). */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { sourceReadSql } from "@/lib/gbrain/access";
import { allowed, colleagues, consentViews, loadClient, type ConsentView } from "./access";
import { listItems, type ItemView } from "./items";
import { PURPOSES, type Discipline, type Purpose } from "./pure";
import { consentHistory, listSessions, loadSession, sharedWith, transcriptOf, type ConsentEventView } from "./records";

export type SessionSummary = { id: string; kind: string; title: string | null; startsAt: string; status: string; work: string; workError: string | null; hasAudio: boolean; hasTranscript: boolean };

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

/** Background work runs in-process: a "running" that hasn't moved for 15 minutes was cut off by a restart. */
const STALE_MS = 15 * 60_000;
const sessionSummary = (s: Awaited<ReturnType<typeof listSessions>>[number]): SessionSummary => {
  const stale = s.work === "running" && Date.now() - s.updatedAt.getTime() > STALE_MS;
  return {
  id: s.id, kind: s.kind, title: s.title, startsAt: s.startsAt.toISOString(), status: s.status, work: stale ? "failed" : s.work, workError: stale ? "interrupted" : s.workError,
  hasAudio: !!s.audioSourceId, hasTranscript: !!s.transcriptSourceId,
  };
};

export async function clientPage(v: Viewer, id: string): Promise<ClientPageData> {
  const rec = await loadClient(v, id);
  const mine = rec.access === "clinician";
  const [consents, events, shared, team, sessions, items] = await Promise.all([
    consentViews(v, rec.id), consentHistory(v, rec.id), mine ? sharedWith(v, rec.id) : Promise.resolve([]),
    mine ? colleagues(v) : Promise.resolve([]), listSessions(v, { clientId: rec.id }), listItems(v, rec),
  ]);
  return {
    client: {
      id: rec.id, label: rec.label, kind: rec.kind, discipline: rec.discipline, ownerName: rec.ownerName, access: rec.access, createdAt: rec.createdAt.toISOString(),
      reason: typeof rec.props.referral_reason === "string" ? rec.props.referral_reason : null,
    },
    consent: { state: rec.consent.state, allowed: Object.fromEntries(PURPOSES.map((p) => [p, rec.consent.allowed[p]])) as Record<Purpose, boolean>, reviewAt: rec.consent.reviewAt?.toISOString() ?? null },
    consents, consentEvents: events, sharedWith: shared, colleagues: team.map((c) => ({ id: c.id, name: c.name })),
    sessions: sessions.map(sessionSummary), items,
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
  const [tr, items] = await Promise.all([transcriptOf(session), listItems(v, client, { sessionId: session.id })]);
  return {
    session: { ...sessionSummary(session), language: session.language, discipline: session.discipline as Discipline },
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
