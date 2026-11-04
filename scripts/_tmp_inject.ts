import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
const { db, sql } = await import("@/db");
const { users, assistantSettings } = await import("@/db/schema");
const { and, eq } = await import("drizzle-orm");
const { proposeSuggestion } = await import("@/lib/automations");
const [u] = await db.select().from(users).where(eq(users.email, "anna@example.com"));
const graphId = process.argv[2], src = process.argv[3];
await db.update(assistantSettings).set({ dailySuggestionCap: 50 }).where(and(eq(assistantSettings.graphId, graphId), eq(assistantSettings.userId, u.id)));
const cases = [["memory", "heartbeat", src], ["memory", "automation", src], ["reminder", "automation", src], ["reminder", "heartbeat", null]] as const;
for (const [kind, origin, s] of cases) {
  const r = await proposeSuggestion({ graphId, userId: u.id, kind, title: `INTEG ${kind} ${origin} ${s ? "doc" : "nodoc"}`, body: null,
    payload: kind === "reminder" ? { title: `INTEG reminder ${origin} ${s ? "doc" : "nodoc"}`, dueAt: new Date(Date.now() + 86400e3).toISOString() } : { text: `INTEG Mr Holm may always pick up Emma (${origin})`, kind: "rule" },
    citations: s ? [{ n: 1, sourceId: s, title: "swim-newsletter-integ.txt" }] : [], origin, dedupeKey: `integ-${kind}-${origin}-${Date.now()}` });
  console.log(kind, origin, s ? "doc" : "nodoc", r.outcome);
}
await db.update(assistantSettings).set({ dailySuggestionCap: 5 }).where(and(eq(assistantSettings.graphId, graphId), eq(assistantSettings.userId, u.id)));
await sql.end();
