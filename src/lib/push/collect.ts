/**
 * What is waiting to be pushed (server-only). Each query only looks at people with a registered device, who are
 * still members of the graph, and things not pushed yet (by delivery key). Text that reaches a notification is
 * decided by ./pure (buildPayload); these only say whether an item is sensitive.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { PushItem } from "./pure";

export type Candidate = { userId: string; key: string; item: PushItem };

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => r as unknown as Row[];
const s = (x: unknown) => (x == null ? null : String(x));
const ms = (x: unknown) => (x instanceof Date ? x : new Date(String(x))).getTime();

/**
 * Reminders that fell due in the last 12 hours, for their owner. Only on devices registered before the reminder was
 * due (a new iPhone doesn't get a burst of old ones). Sensitive when the graph is a practice, or the reminder points
 * at a sensitive person, event or source.
 */
export async function dueReminders(limit = 200): Promise<Candidate[]> {
  const rows = rowsOf(await db.execute(sql`
    select r.id, r.graph_id, r.owner_id, r.title, r.about_node_id,
      (g.kind = 'practice' or coalesce(an.sensitive, false) or coalesce(n.sensitive, false) or coalesce(src.sensitive, false)) as sensitive
    from reminders r
    join graphs g on g.id = r.graph_id and g.archived_at is null
    join graph_members gm on gm.graph_id = r.graph_id and gm.user_id = r.owner_id
    left join nodes an on an.id = r.about_node_id
    left join nodes n on n.id = r.node_id
    left join sources src on src.id = r.source_id
    where r.done = false and r.due_at <= now() and r.due_at > now() - interval '12 hours'
      and exists (select 1 from device_tokens d where d.user_id = r.owner_id and d.created_at < r.due_at)
      and not exists (select 1 from push_deliveries p where p.user_id = r.owner_id and p.key = 'reminder:' || r.id::text)
    order by r.due_at
    limit ${limit}`));
  return rows.map((r) => ({
    userId: String(r.owner_id),
    key: `reminder:${r.id}`,
    item: { kind: "reminder", id: String(r.id), graphId: String(r.graph_id), title: String(r.title ?? ""), sensitive: r.sensitive === true, aboutNodeId: s(r.about_node_id) },
  }));
}

/**
 * Suggestions and change sets waiting for a person, batched per graph: one notification for everything new since
 * the last one, at most every 30 minutes, once a burst has settled for 2 minutes, and only for things from the last
 * day. A person's own drafts don't count.
 */
export async function waitingBatches(limit = 200): Promise<Candidate[]> {
  const rows = rowsOf(await db.execute(sql`
    with w as (
      select s.graph_id, s.user_id, s.created_at, null::uuid as cs_id from suggestions s where s.status = 'pending'
      union all
      select c.graph_id, coalesce(c.for_user_id, c.created_by) as user_id, c.created_at, c.id as cs_id
      from change_sets c where c.status = 'draft' and c.origin not in ('person', 'web', 'restore')
        and coalesce(c.for_user_id, c.created_by) is not null
    ),
    last as (
      select p.user_id, p.graph_id, max(p.created_at) as at from push_deliveries p
      where p.category = 'waiting' and p.status in ('sent', 'sending') group by p.user_id, p.graph_id
    )
    select w.graph_id, w.user_id, g.name as graph_name, count(*)::int as n, count(w.cs_id)::int as cs,
      max(w.cs_id::text) as one_cs, max(w.created_at) as newest,
      (select count(*)::int from graph_members m2 where m2.user_id = w.user_id) as graphs
    from w
    join graphs g on g.id = w.graph_id and g.archived_at is null
    join graph_members gm on gm.graph_id = w.graph_id and gm.user_id = w.user_id
    left join last on last.user_id = w.user_id and last.graph_id = w.graph_id
    where exists (select 1 from device_tokens d where d.user_id = w.user_id)
    group by w.graph_id, w.user_id, g.name, last.at
    having max(w.created_at) < now() - interval '2 minutes'
      and max(w.created_at) > now() - interval '1 day'
      and max(w.created_at) > coalesce(last.at, 'epoch'::timestamptz)
      and coalesce(last.at, 'epoch'::timestamptz) < now() - interval '30 minutes'
    limit ${limit}`));
  return rows.map((r) => {
    const n = Number(r.n), cs = Number(r.cs);
    return {
      userId: String(r.user_id),
      key: `waiting:${r.graph_id}:${ms(r.newest)}`,
      item: {
        kind: "waiting", graphId: String(r.graph_id), graphName: s(r.graph_name), count: n,
        multipleGraphs: Number(r.graphs) > 1, onlyChangeSets: cs === n, changeSetId: cs === 1 ? s(r.one_cs) : null,
      },
    };
  });
}

/** Connections that stopped and need their person (reconnect, sign in again). Once per breakage. */
export async function connectionsNeedingYou(limit = 200): Promise<Candidate[]> {
  const rows = rowsOf(await db.execute(sql`
    select c.id, c.graph_id, c.user_id, c.label, c.last_ok_at
    from connections c
    join graph_members gm on gm.graph_id = c.graph_id and gm.user_id = c.user_id
    where c.status = 'needs_you'
      and exists (select 1 from device_tokens d where d.user_id = c.user_id)
      and not exists (select 1 from push_deliveries p where p.user_id = c.user_id
        and p.key = 'connection:' || c.id::text || ':' || coalesce(floor(extract(epoch from c.last_ok_at))::bigint, 0)::text)
    limit ${limit}`));
  return rows.map((r) => ({
    userId: String(r.user_id),
    key: `connection:${r.id}:${r.last_ok_at ? Math.floor(ms(r.last_ok_at) / 1000) : 0}`,
    item: { kind: "connection", id: String(r.id), graphId: String(r.graph_id), label: String(r.label ?? "") },
  }));
}

/** Open risk flags from the last day, to the clinician they belong to only (never colleagues). No text leaves. */
export async function clinicalRiskFlags(limit = 200): Promise<Candidate[]> {
  const rows = rowsOf(await db.execute(sql`
    select i.id, i.graph_id, i.clinician_id
    from clinical_items i
    join graph_members gm on gm.graph_id = i.graph_id and gm.user_id = i.clinician_id
    where i.kind = 'risk' and i.status = 'open' and i.created_at > now() - interval '1 day'
      and exists (select 1 from device_tokens d where d.user_id = i.clinician_id)
      and not exists (select 1 from push_deliveries p where p.user_id = i.clinician_id and p.key = 'risk:' || i.id::text)
    limit ${limit}`));
  return rows.map((r) => ({
    userId: String(r.clinician_id),
    key: `risk:${r.id}`,
    item: { kind: "clinical", id: String(r.id), graphId: String(r.graph_id) },
  }));
}
