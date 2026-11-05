/**
 * DEV ONLY — synthetic multi-year history for trying out "You" (src/lib/you). `npx tsx scripts/dev-you-history.ts`
 *
 * The demo data spans days; patterns need years. This makes (or resets) ONE throwaway test account with its own
 * household and Personal graph and fills that graph with ~3.5 years of made-up weeks:
 *   Account   you-demo@example.com / demo-demo-demo   ("Sofie", a household of her own)
 *   People    Lars (her brother: in touch a lot, little every autumn), Mette (a friend, fading lately), Jonas
 *   Weeks     meetings (fuller every November, very full the last four weeks), evenings, runs and trips (more in
 *             summer), check-ins about herself (brighter in weeks outdoors with few meetings), commitments (more said
 *             yes to in November, more running late then), documents added.
 * It never touches any other account: it refuses to run in production or against a non-local database, and it only
 * deletes content inside the test account's own graph. Rows are written directly (no change sets): test data only.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const EMAIL = "you-demo@example.com";
const NAME = "Sofie";
const PASSWORD = "demo-demo-demo";
const YEARS = 3.5;

function guard() {
  if (process.env.NODE_ENV === "production") throw new Error("dev-you-history is for development only.");
  const url = process.env.DATABASE_URL ?? "postgres://mygraph:mygraph@localhost:5433/mygraph";
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`Refusing to write test data to ${host}: local databases only.`);
}

/** Deterministic randomness, so the patterns are the same every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const poisson = (r: () => number, mean: number) => { let k = 0, p = 1; const L = Math.exp(-mean); do { k++; p *= r(); } while (p > L && k < 50); return k - 1; };

async function main() {
  guard();
  const { and, eq, sql: q } = await import("drizzle-orm");
  const { db, sql } = await import("@/db");
  const S = await import("@/db/schema");
  const { createAccountWithOwnHousehold } = await import("@/lib/graphs");
  const { hashPassword } = await import("@/lib/auth/passwords");

  // 1. The test account (created once; its graph is emptied and refilled on every run).
  let [user] = await db.select().from(S.users).where(eq(S.users.email, EMAIL));
  if (!user) {
    const hash = await hashPassword(PASSWORD);
    await db.transaction((tx) => createAccountWithOwnHousehold(tx, { name: NAME, email: EMAIL, passwordHash: hash }));
    [user] = await db.select().from(S.users).where(eq(S.users.email, EMAIL));
    console.log(`created ${EMAIL}`);
  }
  const [graph] = await db.select().from(S.graphs).where(and(eq(S.graphs.ownerId, user.id), eq(S.graphs.kind, "personal")));
  if (!graph || graph.householdId !== user.householdId) throw new Error("The test account has no Personal graph of its own.");
  const g = graph.id, h = user.householdId, me = user.id;
  const [self] = await db.select().from(S.nodes).where(and(eq(S.nodes.graphId, g), eq(S.nodes.type, "person"), q`${S.nodes.props}->>'userId' = ${me}`));
  if (!self) throw new Error("No self node for the test account.");

  // Only ever this graph, only this account's rows.
  const members = await db.select({ u: S.graphMembers.userId }).from(S.graphMembers).where(eq(S.graphMembers.graphId, g));
  if (members.some((m) => m.u !== me)) throw new Error("The test graph has other members; not touching it.");
  await db.delete(S.personInteractions).where(eq(S.personInteractions.graphId, g));
  await db.delete(S.observations).where(eq(S.observations.graphId, g));
  await db.delete(S.edges).where(eq(S.edges.graphId, g));
  await db.delete(S.sources).where(eq(S.sources.graphId, g));
  await db.delete(S.nodes).where(and(eq(S.nodes.graphId, g), q`${S.nodes.id} <> ${self.id}`));
  await db.delete(S.youInsights).where(eq(S.youInsights.graphId, g));
  await db.delete(S.youSettings).where(eq(S.youSettings.graphId, g));

  const base = { householdId: h, graphId: g, ownerId: me, visibility: "private" as const };
  const now = new Date();
  const start = new Date(now.getTime() - YEARS * 365.25 * 86_400_000);
  const weekStarts: Date[] = [];
  for (let t = start.getTime(); t < now.getTime() - 86_400_000; t += 7 * 86_400_000) weekStarts.push(new Date(t));
  const r = rng(20261105);

  // 2. People.
  const [lars, mette, jonas] = await db.insert(S.nodes).values([
    { ...base, type: "person", kind: "sibling", label: "Lars", summary: "Sofie's brother." },
    { ...base, type: "person", kind: "friend", label: "Mette" },
    { ...base, type: "person", kind: "colleague", label: "Jonas" },
  ]).returning({ id: S.nodes.id });
  await db.insert(S.edges).values({ ...base, fromId: self.id, toId: lars.id, relation: "sibling_of", status: "confirmed" });
  const chats = await db.insert(S.sources).values([
    { ...base, kind: "upload", title: "WhatsApp with Lars", status: "ready", meta: { importer: "whatsapp" }, mime: "text/plain" },
    { ...base, kind: "upload", title: "WhatsApp with Mette", status: "ready", meta: { importer: "whatsapp" }, mime: "text/plain" },
    { ...base, kind: "upload", title: "Messages with Jonas", status: "ready", meta: { importer: "imessage" }, mime: "text/plain" },
  ]).returning({ id: S.sources.id });

  const interactions: (typeof S.personInteractions.$inferInsert)[] = [];
  const events: (typeof S.nodes.$inferInsert & { _involves?: boolean })[] = [];
  const checkins: (typeof S.observations.$inferInsert)[] = [];
  const commitments: (typeof S.nodes.$inferInsert)[] = [];
  const docs: (typeof S.sources.$inferInsert)[] = [];
  const at = (w: Date, day: number, hour: number, min = 0) => new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + day, hour - 1, min));

  weekStarts.forEach((w, wi) => {
    const month = new Date(w.getTime() + 3 * 86_400_000).getUTCMonth();
    const autumn = month >= 8 && month <= 10;
    const summer = month >= 5 && month <= 7;
    const recent = wi >= weekStarts.length - 4;
    const last12 = wi >= weekStarts.length - 12;
    // Contact.
    const msg = (person: string, src: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const day = Math.floor(r() * 7);
        interactions.push({ ...base, nodeId: person, at: at(w, day, 9 + Math.floor(r() * 12)), kind: "message", strength: "strong", weight: 1, sourceId: src, detail: "Message", dedupeKey: `source:${src}:${wi}:${i}` });
      }
    };
    msg(lars.id, chats[0].id, poisson(r, autumn ? 0.3 : 2.6));
    msg(mette.id, chats[1].id, poisson(r, last12 ? 0.05 : 1.6));
    msg(jonas.id, chats[2].id, poisson(r, 1));
    // Meetings (timed, involving her): fuller every November, very full the last four weeks.
    const nMeet = poisson(r, recent ? 13 : month === 10 ? 10 : summer ? 2.5 : 5);
    for (let i = 0; i < nMeet; i++) {
      const evening = r() < (month === 10 ? 0.35 : 0.08);
      const s = at(w, evening && r() < 0.4 ? 5 : Math.floor(r() * 5), evening ? 19 : 9 + Math.floor(r() * 7));
      events.push({ ...base, type: "event", label: ["Team meeting", "Planning", "1:1", "Review", "Parents' evening", "Board meeting"][Math.floor(r() * 6)], startAt: s, endAt: new Date(s.getTime() + 3_600_000), timePrecision: "minute", props: {}, _involves: true });
    }
    // Outdoors: runs and walks, more in summer; a trip every July.
    const nOut = poisson(r, summer ? 2.6 : month <= 1 || month === 11 ? 0.5 : 1.3);
    let outdoorsDays = 0;
    for (let i = 0; i < nOut; i++) {
      const s = at(w, Math.floor(r() * 7), 7 + Math.floor(r() * 4));
      events.push({ ...base, type: "event", kind: "activity", label: r() < 0.5 ? "Run by the lake" : "Walk in the woods", startAt: s, endAt: new Date(s.getTime() + 3_600_000), timePrecision: "minute", props: {}, _involves: true });
      outdoorsDays++;
    }
    if (month === 6 && new Date(w.getTime()).getUTCDate() <= 7) {
      const s = at(w, 4, 0);
      events.push({ ...base, type: "event", kind: "trip", label: "Summer house on Fanø", startAt: s, endAt: new Date(s.getTime() + 5 * 86_400_000), timePrecision: "day", props: { allDay: true, from: "location history" }, _involves: true });
      outdoorsDays += 3;
    }
    // Check-ins about herself: brighter in weeks outdoors with few meetings.
    const nCheck = poisson(r, 1.4);
    for (let i = 0; i < nCheck; i++) {
      const good = (outdoorsDays >= 1 ? 0.8 : -0.2) + (nMeet <= 4 ? 0.6 : -0.5) + (r() - 0.5) * 1.2;
      const score = Math.max(1, Math.min(5, Math.round(3 + good)));
      checkins.push({ householdId: h, graphId: g, ownerId: me, personNodeId: self.id, kind: "wellbeing", score, note: score >= 4 ? "Good week, rested." : score <= 2 ? "Tired, too much on." : null, at: at(w, Math.floor(r() * 7), 21), visibility: "private" });
    }
    // Commitments: more said yes to in November, and more of them running late then.
    const nCommit = poisson(r, month === 10 ? 3.5 : 1);
    for (let i = 0; i < nCommit; i++) {
      const created = at(w, Math.floor(r() * 5), 10);
      const due = new Date(created.getTime() + (7 + Math.floor(r() * 14)) * 86_400_000);
      const late = r() < (month === 10 ? 0.7 : 0.12);
      const status = due.getTime() > now.getTime() ? "open" : late ? "missed" : "done";
      commitments.push({
        ...base, type: "commitment", kind: "other", label: ["Send the slides to Jonas", "Bake for the school fair", "Reply to the housing association", "Help Lars move", "Review the budget"][Math.floor(r() * 5)],
        startAt: due, createdAt: created,
        props: { direction: "promise", status, kind: "other", dueAt: due.toISOString(), dueKind: "date", ...(status === "done" ? { doneAt: new Date(due.getTime() - 86_400_000).toISOString(), doneBy: me } : {}) },
      });
    }
    // Things added to read.
    for (let i = 0; i < poisson(r, 0.7); i++) docs.push({ ...base, kind: "upload", title: ["Article on sleep", "Book notes", "Course handout", "Report draft"][Math.floor(r() * 4)], status: "ready", mime: "application/pdf", createdAt: at(w, Math.floor(r() * 7), 20) });
  });

  // 3. Write it all (in chunks).
  const chunked = async <T,>(rows: T[], n: number, fn: (part: T[]) => Promise<unknown>) => { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); };
  const involve: string[] = [];
  await chunked(events, 500, async (part) => {
    const made = await db.insert(S.nodes).values(part.map(({ _involves, ...e }) => { void _involves; return e; })).returning({ id: S.nodes.id });
    involve.push(...made.map((m) => m.id));
  });
  await chunked(involve, 500, (part) => db.insert(S.edges).values(part.map((id) => ({ ...base, fromId: id, toId: self.id, relation: "involves", status: "confirmed" as const }))));
  await chunked(interactions, 1000, (part) => db.insert(S.personInteractions).values(part));
  await chunked(checkins, 1000, (part) => db.insert(S.observations).values(part));
  await chunked(commitments, 500, (part) => db.insert(S.nodes).values(part));
  await chunked(docs, 500, (part) => db.insert(S.sources).values(part));

  console.log(`${EMAIL} / ${PASSWORD} — graph "${graph.name}" (${g})`);
  console.log(`weeks ${weekStarts.length}, events ${events.length}, messages ${interactions.length}, check-ins ${checkins.length}, commitments ${commitments.length}, documents ${docs.length}`);
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("dev-you-history failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
