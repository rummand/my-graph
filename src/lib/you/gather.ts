/**
 * What "You" reads (server-only). Only rows that are the person's OWN or ABOUT them, and that they may read:
 *   - events they are part of (event —involves→ their own person node) or that they added,
 *   - their contact with people: interactions whose carrier they added (their messages, calls, mail) or an event they
 *     were part of — never another member's private conversations,
 *   - commitments they are responsible for or added,
 *   - their own check-ins about themself; with the mood setting on, the tone of notes and pages they wrote themself,
 *   - documents they added.
 * Current graph: the viewer's normal read rules on top. Combined (opt-in): from the person's other graphs ONLY rows
 * they own — never a partner's, a colleague's or anyone else's, even where the person could read them. Health events
 * are never read. Links (receipts) are only made for the current graph; other graphs give counts only.
 */
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { graphMembers, graphs, nodes } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { nodeReadSql, sourceReadSql } from "@/lib/gbrain/access";
import { SELF_USER_PROP } from "@/lib/graphs/pure";
import type { CommitmentRow, ContactRow, DocRow, EventRow, MoodRow, Raw } from "./signals";

type Ctx = { v: Viewer; from: Date; now: Date; others: string[]; selfIds: string[]; mood: boolean };

const ids = (xs: string[]) => (xs.length ? sql.join(xs.map((x) => sql`${x}::uuid`), sql`, `) : sql`null::uuid`);
const d = (x: unknown) => (x instanceof Date ? x : new Date(String(x)));

/** The person's other graphs (where they are still a member and which aren't archived). */
export async function otherGraphsOf(v: Viewer): Promise<string[]> {
  const rows = await db.select({ id: graphs.id }).from(graphMembers).innerJoin(graphs, eq(graphs.id, graphMembers.graphId))
    .where(and(eq(graphMembers.userId, v.id), ne(graphs.id, v.graphId), sql`${graphs.archivedAt} is null`));
  return rows.map((r) => r.id);
}

/** The person's own node in each graph read (current: v.personNodeId; others: their self marker). */
async function selfNodes(v: Viewer, others: string[]): Promise<string[]> {
  const out = v.personNodeId ? [v.personNodeId] : [];
  if (others.length) {
    const rows = await db.select({ id: nodes.id }).from(nodes)
      .where(and(inArray(nodes.graphId, others), eq(nodes.type, "person"), eq(nodes.ownerId, v.id), sql`${nodes.props}->>${SELF_USER_PROP} = ${v.id}`, sql`${nodes.mergedInto} is null`));
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

/** WHERE: a row under `alias` is readable here, or (combined) the person's own in one of their other graphs. */
function scope(c: Ctx, alias: string, read: SQL): SQL {
  const a = sql.raw(`"${alias}"`);
  if (!c.others.length) return read;
  return sql`(${read} or (${a}.graph_id in (${ids(c.others)}) and ${a}.owner_id = ${c.v.id}))`;
}

const involvesSelf = (c: Ctx, alias: string) => sql`exists (select 1 from edges e where e.from_id = ${sql.raw(`"${alias}"`)}.id and e.to_id in (${ids(c.selfIds)})
  and e.relation in ('involves', 'attends', 'attended_by', 'participant') and e.status not in ('rejected', 'superseded'))`;

async function events(c: Ctx): Promise<EventRow[]> {
  const ctx = await accessContext(c.v);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select n.id, n.kind, n.label, n.start_at, n.end_at, n.props, n.graph_id from nodes n
    where n.type = 'event' and n.merged_into is null and n.start_at >= ${c.from.toISOString()}::timestamptz and n.start_at <= ${c.now.toISOString()}::timestamptz
      and coalesce(n.props->>'health', '') = ''
      and ${scope(c, "n", nodeReadSql(ctx, "n"))}
      and (n.owner_id = ${c.v.id} or ${involvesSelf(c, "n")})
    order by n.start_at limit 20000`);
  return [...rows].map((r) => ({
    id: String(r.id), kind: (r.kind as string | null) ?? null, label: String(r.label), startAt: d(r.start_at), endAt: r.end_at ? d(r.end_at) : null,
    props: (r.props as Record<string, unknown>) ?? {}, href: r.graph_id === c.v.graphId ? `/node/${r.id}` : null,
  }));
}

async function contacts(c: Ctx): Promise<ContactRow[]> {
  const ctx = await accessContext(c.v);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select pi.node_id, p.label, pi.at, pi.source_id, pi.subject_id, pi.detail, pi.graph_id from person_interactions pi
    join nodes p on p.id = pi.node_id and p.merged_into is null
    left join sources s on s.id = pi.source_id
    left join nodes cn on cn.id = pi.subject_id
    where pi.at >= ${c.from.toISOString()}::timestamptz and pi.at <= ${c.now.toISOString()}::timestamptz and pi.kind not in ('edit', 'mention')
      ${c.selfIds.length ? sql`and pi.node_id not in (${ids(c.selfIds)})` : sql``}
      and (
        (pi.graph_id = ${c.v.graphId} and (
          (pi.source_id is not null and s.id is not null and s.owner_id = ${c.v.id} and ${sourceReadSql(ctx, "s")})
          or (pi.source_id is null and cn.id is not null and ${nodeReadSql(ctx, "cn")} and (cn.owner_id = ${c.v.id} or ${involvesSelf(c, "cn")}))
        ))
        ${c.others.length ? sql`or (pi.graph_id in (${ids(c.others)}) and pi.owner_id = ${c.v.id})` : sql``}
      )
    order by pi.at limit 50000`);
  return [...rows].map((r) => {
    const here = r.graph_id === c.v.graphId;
    const href = !here ? null : r.source_id ? `/library/${r.source_id}` : r.subject_id ? `/node/${r.subject_id}` : null;
    return { personId: String(r.node_id), name: String(r.label), at: d(r.at), href, title: String(r.detail ?? r.label) };
  });
}

async function commitments(c: Ctx): Promise<CommitmentRow[]> {
  const ctx = await accessContext(c.v);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select n.id, n.label, n.created_at, n.props, n.graph_id from nodes n
    where n.type = 'commitment' and n.merged_into is null and n.created_at >= ${c.from.toISOString()}::timestamptz
      and ${scope(c, "n", nodeReadSql(ctx, "n"))}
      and (n.owner_id = ${c.v.id} or exists (select 1 from edges e where e.to_id = n.id and e.from_id in (${ids(c.selfIds)})
        and e.relation = 'responsible_for' and e.status not in ('rejected', 'superseded')))
    limit 20000`);
  return [...rows].map((r) => ({ id: String(r.id), label: String(r.label), createdAt: d(r.created_at), props: (r.props as Record<string, unknown>) ?? {}, href: r.graph_id === c.v.graphId ? `/node/${r.id}` : null }));
}

/** The person's own check-ins about themself (always), and the text of their own notes (only for the tone, opt-in). */
async function moodRows(c: Ctx): Promise<{ checkins: MoodRow[]; texts: { at: Date; text: string; href: string | null; title: string }[] }> {
  if (!c.selfIds.length) return { checkins: [], texts: [] };
  const graphsRead = [c.v.graphId, ...c.others];
  const obs = await db.execute<Record<string, unknown>>(sql`
    select o.id, o.at, o.score, o.note, o.kind, o.person_node_id, o.graph_id from observations o
    where o.owner_id = ${c.v.id} and o.person_node_id in (${ids(c.selfIds)}) and o.graph_id in (${ids(graphsRead)})
      and o.at >= ${c.from.toISOString()}::timestamptz and o.at <= ${c.now.toISOString()}::timestamptz and o.author_kind = 'user'
    order by o.at limit 20000`);
  const checkins: MoodRow[] = [];
  const texts: { at: Date; text: string; href: string | null; title: string }[] = [];
  for (const r of obs) {
    const here = r.graph_id === c.v.graphId;
    const href = here ? `/people/${r.person_node_id}#wellbeing` : null;
    if (r.kind === "wellbeing" && typeof r.score === "number") checkins.push({ at: d(r.at), value: (Number(r.score) - 3) / 2, href, title: "Check-in" });
    if (c.mood && typeof r.note === "string" && r.note.trim()) texts.push({ at: d(r.at), text: r.note, href, title: "Note" });
  }
  if (c.mood) {
    const revs = await db.execute<Record<string, unknown>>(sql`
      select r.created_at, r.content_text, r.title, p.slug, p.graph_id from wiki_revisions r join wiki_pages p on p.id = r.page_id
      where r.author_id = ${c.v.id} and r.author_kind = 'user' and p.owner_id = ${c.v.id} and p.graph_id in (${ids(graphsRead)})
        and r.created_at >= ${c.from.toISOString()}::timestamptz order by r.created_at limit 5000`);
    for (const r of revs) texts.push({ at: d(r.created_at), text: String(r.content_text ?? "").slice(0, 4000), href: r.graph_id === c.v.graphId ? `/artifacts/pages/${r.slug}` : null, title: String(r.title) });
  }
  return { checkins, texts };
}

async function docs(c: Ctx): Promise<DocRow[]> {
  const graphsRead = [c.v.graphId, ...c.others];
  const rows = await db.execute<Record<string, unknown>>(sql`
    select s.id, s.title, s.created_at, s.kind, s.mime, s.graph_id from sources s
    where s.owner_id = ${c.v.id} and s.graph_id in (${ids(graphsRead)}) and s.created_at >= ${c.from.toISOString()}::timestamptz
      and s.kind in ('upload', 'web', 'connector', 'sync', 'email') and not s.sensitive
      and coalesce(s.mime, '') not like 'image/%' and coalesce(s.mime, '') not like 'audio/%' and coalesce(s.mime, '') not like 'video/%'
      and coalesce(s.meta->>'importer', '') = ''
    limit 20000`);
  return [...rows].map((r) => ({
    at: d(r.created_at), title: String(r.title), href: r.graph_id === c.v.graphId ? `/library/${r.id}` : null,
    work: r.kind === "connector" || r.kind === "sync" || r.kind === "email",
  }));
}

export type Gathered = Raw & { moodTexts: { at: Date; text: string; href: string | null; title: string }[] };

/** Everything You reads for this person, from `from` to `now`. */
export async function gather(v: Viewer, opts: { from: Date; now: Date; combine: boolean; mood: boolean }): Promise<Gathered> {
  const others = opts.combine ? await otherGraphsOf(v) : [];
  const selfIds = await selfNodes(v, others);
  const c: Ctx = { v, from: opts.from, now: opts.now, others, selfIds, mood: opts.mood };
  const [ev, co, cm, mo, dc] = await Promise.all([events(c), contacts(c), commitments(c), moodRows(c), docs(c)]);
  return { events: ev, contacts: co, commitments: cm, mood: mo.checkins, docs: dc, moodTexts: mo.texts };
}
