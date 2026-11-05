/**
 * The gentle "keep in touch" nudge on Today (server). At most one person, only someone who used to be close and has
 * gone quiet (never a faded acquaintance), and only when the viewer turned it on (assistant_settings.keepInTouchNudges).
 */
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import { db } from "@/db";
import { assistantSettings, edges } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { memberSelfNodes } from "@/lib/graphs/self";
import { visibleWhere } from "@/lib/people/access";
import { viewerPersonId, visibleNodes } from "@/lib/people/data";
import { pickNudge } from "./pure";
import { closeFamilyOf, closenessFor, type PersonCloseness } from "./read";

export async function nudgesOn(v: Viewer): Promise<boolean> {
  if (!v.graphId) return false;
  const [s] = await db.select({ on: assistantSettings.keepInTouchNudges }).from(assistantSettings)
    .where(and(eq(assistantSettings.graphId, v.graphId), eq(assistantSettings.userId, v.id))).limit(1);
  return !!s?.on;
}

export async function keepInTouchNudge(v: Viewer, now = new Date()): Promise<{ id: string; label: string; closeness: PersonCloseness } | null> {
  if (!(await nudgesOn(v))) return null;
  const [persons, viewerNodeId, selves] = await Promise.all([visibleNodes(v, ["person"]), viewerPersonId(v), memberSelfNodes(v.graphId)]);
  if (!persons.length) return null;
  const fam = viewerNodeId
    ? await db.select({ fromId: edges.fromId, toId: edges.toId, relation: edges.relation, status: edges.status }).from(edges)
      .where(and(or(eq(edges.fromId, viewerNodeId), eq(edges.toId, viewerNodeId)), notInArray(edges.status, ["rejected", "superseded"]),
        inArray(edges.relation, ["parent_of", "partner_of", "sibling_of", "grandparent_of", "role:parent", "role:child", "role:partner", "role:sibling", "role:grandparent"]), visibleWhere(v, edges)))
    : [];
  const near = await closenessFor(v, persons, { viewerNodeId, members: new Set(selves.values()), family: closeFamilyOf(viewerNodeId, fam), now });
  const pick = pickNudge(persons.filter((p) => p.id !== viewerNodeId).map((p) => ({ id: p.id, label: p.label, closeness: near.get(p.id)! })).filter((p) => p.closeness));
  return pick;
}
