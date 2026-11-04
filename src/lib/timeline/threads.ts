/**
 * One conversation, in order (server-only): every message the viewer may open, with who wrote to whom, the text,
 * where its date came from, what was proposed from it, and its attachments. Used by the timeline drawer and the
 * library's thread page.
 */
import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { cleanSubject } from "./documents";

export type ThreadMessageDetail = {
  sourceId: string; title: string; at: string | null; from: string | null; to: string | null; cc: string | null;
  body: string; dateFrom: { origin: string; quote: string | null } | null;
  changeSetId: string | null; proposedTotal: number;
  attachments: { id: string; title: string }[];
};

export type ThreadDetail = { key: string | null; subject: string; messages: ThreadMessageDetail[] };

const BODY_MAX = 4000;

/** The message text without the header block emailToText puts first. */
function bodyOf(text: string | null): string {
  if (!text) return "";
  const t = text.replace(/\r\n/g, "\n");
  const i = t.indexOf("\n\n");
  const head = i >= 0 ? t.slice(0, i) : "";
  const body = /^(Subject|From|To|Cc|Date|Attachments): /m.test(head) ? t.slice(i + 2) : t;
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX).trimEnd()}\n…` : body.trim();
}

export async function loadThread(v: Viewer, q: { key?: string; ids?: string[] }): Promise<ThreadDetail | null> {
  if (!(await accessContext(v)).active) return null;
  const which = q.ids?.length ? inArray(sources.id, q.ids) : q.key ? eq(sources.threadKey, q.key) : null;
  if (!which) return null;
  const rows = await db.select({
    id: sources.id, title: sources.title, documentDate: sources.documentDate, createdAt: sources.createdAt, threadKey: sources.threadKey,
    textContent: sources.textContent, meta: sources.meta,
  }).from(sources)
    .where(and(sourceVisibleTo(v), which, sql`(${sources.mime} = 'message/rfc822' or ${sources.kind} = 'email')`))
    .orderBy(asc(sql`coalesce(${sources.documentDate}, ${sources.createdAt})`), asc(sources.id)).limit(300);
  if (!rows.length) return null;

  const ids = rows.map((r) => r.id);
  const atts = await db.select({ id: sources.id, title: sources.title, parent: sql<string>`${sources.meta}->>'parentSourceId'` }).from(sources)
    .where(and(sourceVisibleTo(v), inArray(sql`${sources.meta}->>'parentSourceId'`, ids)));
  const byParent = new Map<string, { id: string; title: string }[]>();
  for (const a of atts) (byParent.get(a.parent) ?? byParent.set(a.parent, []).get(a.parent)!).push({ id: a.id, title: a.title });

  const messages = rows.map((r): ThreadMessageDetail => {
    const m = r.meta ?? {};
    const e = (m.email ?? {}) as { from?: string | null; to?: string | null; cc?: string | null };
    const df = m.documentDateFrom as { origin?: string; quote?: string | null } | undefined;
    return {
      sourceId: r.id, title: r.title, at: (r.documentDate ?? r.createdAt).toISOString(),
      from: e.from ?? null, to: e.to ?? null, cc: e.cc ?? null, body: bodyOf(r.textContent),
      dateFrom: df?.origin ? { origin: df.origin, quote: df.quote ?? null } : null,
      changeSetId: typeof m.changeSetId === "string" ? m.changeSetId : null,
      proposedTotal: typeof m.proposedTotal === "number" ? m.proposedTotal : 0,
      attachments: byParent.get(r.id) ?? [],
    };
  });
  return { key: rows[0].threadKey ?? q.key ?? null, subject: cleanSubject(rows[0].title), messages };
}
