import { and, eq, inArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { edges, graphMembers, graphs, nodes, reminders, sources, users, wikiPages } from "@/db/schema";
import { audit, requireUserApi } from "@/lib/auth";
import { handle } from "@/lib/auth/http";

/**
 * GET: a JSON copy of your own account and of what you added, in the graphs you are still a member of.
 * Only rows you own: nothing another person added, and nothing from a graph you have left. Files stay on the
 * server (their names and dates are listed); embeddings and password data are never included.
 */
export async function GET() {
  return handle(async () => {
    const v = await requireUserApi();
    const memberOf = await db.select({ id: graphs.id, name: graphs.name, kind: graphs.kind, role: graphMembers.role })
      .from(graphMembers).innerJoin(graphs, eq(graphs.id, graphMembers.graphId))
      .where(eq(graphMembers.userId, v.id));
    const ids = memberOf.map((g) => g.id);
    // inArray with an empty list is refused by drizzle; a graph id that can't exist keeps the queries uniform.
    const scope = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
    const mine = (t: { ownerId: AnyPgColumn; graphId: AnyPgColumn }) => and(eq(t.ownerId, v.id), inArray(t.graphId, scope));

    const [[account], myNodes, myEdges, mySources, myPages, myReminders] = await Promise.all([
      db.select({ id: users.id, name: users.name, email: users.email, role: users.role, locale: users.locale, theme: users.theme, timeZone: users.timeZone, createdAt: users.createdAt })
        .from(users).where(eq(users.id, v.id)),
      db.select({ id: nodes.id, graphId: nodes.graphId, type: nodes.type, kind: nodes.kind, label: nodes.label, aliases: nodes.aliases, summary: nodes.summary,
        props: nodes.props, startAt: nodes.startAt, endAt: nodes.endAt, visibility: nodes.visibility, createdAt: nodes.createdAt, updatedAt: nodes.updatedAt })
        .from(nodes).where(mine(nodes)),
      db.select({ id: edges.id, graphId: edges.graphId, fromId: edges.fromId, toId: edges.toId, relation: edges.relation, props: edges.props,
        status: edges.status, confidence: edges.confidence, visibility: edges.visibility, createdAt: edges.createdAt })
        .from(edges).where(mine(edges)),
      db.select({ id: sources.id, graphId: sources.graphId, kind: sources.kind, title: sources.title, mime: sources.mime, size: sources.size,
        documentDate: sources.documentDate, url: sources.url, visibility: sources.visibility, createdAt: sources.createdAt })
        .from(sources).where(mine(sources)),
      db.select({ id: wikiPages.id, graphId: wikiPages.graphId, slug: wikiPages.slug, title: wikiPages.title, text: wikiPages.contentText,
        content: wikiPages.content, visibility: wikiPages.visibility, updatedAt: wikiPages.updatedAt })
        .from(wikiPages).where(mine(wikiPages)),
      db.select({ id: reminders.id, graphId: reminders.graphId, title: reminders.title, detail: reminders.detail, dueAt: reminders.dueAt, done: reminders.done })
        .from(reminders).where(mine(reminders)),
    ]);

    await audit(v, "account.export", { type: "user", id: v.id }, { nodes: myNodes.length, sources: mySources.length });
    const body = JSON.stringify({
      exportedAt: new Date().toISOString(), account, graphs: memberOf,
      nodes: myNodes, edges: myEdges, sources: mySources, wikiPages: myPages, reminders: myReminders,
    }, null, 2);
    const day = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="my-graph-export-${day}.json"`,
        "cache-control": "no-store",
      },
    });
  });
}
