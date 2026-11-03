/**
 * Demo household (idempotent): `npm run db:seed` / `npx tsx scripts/seed.ts`.
 *   Owner   anna@example.com   / demo-demo-demo
 *   Parent  mikkel@example.com / demo-demo-demo
 *   Child   emma (born 2016)   / demo-demo-demo
 *   Child   noah (born 2019)   / demo-demo-demo
 * Graphs: the household's Family graph (everyone above), Anna's "Work", and "For Sara" — owned by Anna and shared
 * with Sara (sara@example.com / demo-demo-demo, a household of her own) as editor.
 * Every member gets their own person node in their own brain; both parents get parent_of facts to both children,
 * each with a provenance row. Running it again changes nothing that is already there.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const PASSWORD = "demo-demo-demo";
const HOUSEHOLD = "Demo family";

type Member = { email: string; name: string; role: "owner" | "parent" | "child"; birthYear?: number };
const MEMBERS: Member[] = [
  { email: "anna@example.com", name: "Anna", role: "owner" },
  { email: "mikkel@example.com", name: "Mikkel", role: "parent" },
  { email: "emma", name: "Emma", role: "child", birthYear: 2016 },
  { email: "noah", name: "Noah", role: "child", birthYear: 2019 },
];

const SARA = { email: "sara@example.com", name: "Sara" };

async function main() {
  const { and, eq } = await import("drizzle-orm");
  const { db, sql } = await import("@/db");
  const { edges, graphs, households, nodes, provenance, users } = await import("@/db/schema");
  const { createAccount, createPersonNode, linkParentOf } = await import("@/lib/auth/members");
  const { createAccountWithOwnHousehold } = await import("@/lib/graphs");
  const { DEFAULT_HUES } = await import("@/lib/graphs/pure");
  const { upsertMember } = await import("@/lib/graphs/store");
  const { hashPassword } = await import("@/lib/auth/passwords");
  const { writeAudit } = await import("@/lib/auth/audit");

  const passwordHash = await hashPassword(PASSWORD);
  const log: string[] = [];

  await db.transaction(async (tx) => {
    const ids = new Map<string, { userId: string; personNodeId: string; role: Member["role"] }>();

    // Household: the one the owner belongs to, else the one named "Demo family", else a new one.
    const [owner] = await tx.select().from(users).where(eq(users.email, MEMBERS[0].email));
    let householdId = owner?.householdId;
    if (!householdId) {
      const [h] = await tx.select().from(households).where(eq(households.name, HOUSEHOLD)).limit(1);
      householdId = h?.id ?? (await tx.insert(households).values({ name: HOUSEHOLD }).returning({ id: households.id }))[0].id;
      if (!h) log.push(`created household "${HOUSEHOLD}"`);
    }

    for (const m of MEMBERS) {
      const [existing] = await tx.select().from(users).where(eq(users.email, m.email));
      if (existing) {
        if (existing.householdId !== householdId) throw new Error(`${m.email} already belongs to another household; not touching it.`);
        let personNodeId = existing.personNodeId;
        if (!personNodeId) {
          personNodeId = await createPersonNode(tx, {
            householdId, ownerId: existing.id, label: existing.name, role: existing.role, birthYear: existing.birthYear,
            agentId: existing.id, note: "Created by the demo seed",
          });
          await tx.update(users).set({ personNodeId }).where(eq(users.id, existing.id));
          log.push(`gave ${m.name} a person node`);
        }
        ids.set(m.email, { userId: existing.id, personNodeId, role: m.role });
        continue;
      }
      const ownerId = ids.get(MEMBERS[0].email)?.userId ?? null;
      const acct = await createAccount(tx, {
        householdId, role: m.role, name: m.name, email: m.email, passwordHash, birthYear: m.birthYear ?? null,
      }, ownerId);
      ids.set(m.email, { ...acct, role: m.role });
      log.push(`created ${m.role} ${m.name} (${m.email})`);
    }

    const parents = [...ids.values()].filter((x) => x.role === "owner" || x.role === "parent");
    const children = [...ids.entries()].filter(([, x]) => x.role === "child");
    for (const p of parents) {
      for (const [, c] of children) {
        await linkParentOf(tx, {
          householdId, parentUserId: p.userId, parentNodeId: p.personNodeId, childNodeId: c.personNodeId, agentId: p.userId,
          note: "Demo seed: family structure",
        });
      }
    }
    log.push(`ensured ${parents.length * children.length} parent_of facts`);

    if (log.some((l) => l.startsWith("created"))) {
      const anna = ids.get(MEMBERS[0].email)!;
      await writeAudit({ id: anna.userId, householdId }, "setup.complete", { type: "household", id: householdId }, { householdName: HOUSEHOLD, seed: true });
    }

    // ── More graphs, to show that graphs are separate: Anna's "Work", and "For Sara", which Anna shares with Sara
    // (another household). Sara sees "For Sara" and her own Personal graph — never the Demo family or Work.
    const anna = ids.get(MEMBERS[0].email)!;
    const graphNamed = async (name: string, kind: "work" | "shared") => {
      const [g] = await tx.select().from(graphs).where(and(eq(graphs.ownerId, anna.userId), eq(graphs.name, name)));
      if (g) return g.id;
      const [row] = await tx.insert(graphs).values({ householdId, ownerId: anna.userId, name, kind, color: DEFAULT_HUES[kind] }).returning({ id: graphs.id });
      await upsertMember(tx, row.id, anna.userId, "owner", anna.userId);
      log.push(`created graph "${name}"`);
      return row.id;
    };
    const node = async (graphId: string, ownerId: string, n: { type: "person" | "place" | "event" | "topic"; label: string; summary?: string; startAt?: Date; visibility?: "private" | "household" }) => {
      const [have] = await tx.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.graphId, graphId), eq(nodes.label, n.label)));
      if (have) return have.id;
      const [row] = await tx.insert(nodes).values({
        householdId, graphId, ownerId, type: n.type, label: n.label, summary: n.summary ?? null, startAt: n.startAt ?? null,
        timePrecision: n.startAt ? "day" : null, visibility: n.visibility ?? "household",
      }).returning({ id: nodes.id });
      await tx.insert(provenance).values({ householdId, graphId, subjectType: "node", subjectId: row.id, activity: "manual_edit", agentType: "user", agentId: ownerId, confidence: 1, note: "Demo seed" });
      return row.id;
    };
    const fact = async (graphId: string, ownerId: string, fromId: string, relation: string, toId: string) => {
      const [have] = await tx.select({ id: edges.id }).from(edges).where(and(eq(edges.graphId, graphId), eq(edges.fromId, fromId), eq(edges.relation, relation), eq(edges.toId, toId)));
      if (have) return;
      const [row] = await tx.insert(edges).values({ householdId, graphId, ownerId, fromId, toId, relation, status: "confirmed", confidence: 1, visibility: "household" }).returning({ id: edges.id });
      await tx.insert(provenance).values({ householdId, graphId, subjectType: "edge", subjectId: row.id, activity: "manual_edit", agentType: "user", agentId: ownerId, confidence: 1, note: "Demo seed" });
    };

    const work = await graphNamed("Work", "work");
    await node(work, anna.userId, { type: "topic", label: "Quarterly planning", summary: "Budget review with the design team" });

    const forSara = await graphNamed("For Sara", "shared");
    let [sara] = await tx.select().from(users).where(eq(users.email, SARA.email));
    if (!sara) {
      const acct = await createAccountWithOwnHousehold(tx, { name: SARA.name, email: SARA.email, passwordHash });
      [sara] = await tx.select().from(users).where(eq(users.id, acct.userId));
      log.push(`created Sara (${SARA.email}) in a household of her own`);
    } else if (sara.householdId === householdId) {
      throw new Error(`${SARA.email} belongs to the demo household; she should have a household of her own.`);
    }
    await upsertMember(tx, forSara, sara.id, "editor", anna.userId);
    const annaInSara = await node(forSara, anna.userId, { type: "person", label: "Anna", summary: "Made this graph for Sara" });
    const saraNode = await node(forSara, anna.userId, { type: "person", label: "Sara" });
    const trip = await node(forSara, anna.userId, { type: "event", label: "Weekend in Skagen", startAt: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 4, 16)) });
    const cafe = await node(forSara, anna.userId, { type: "place", label: "Café Norden", summary: "Where we first met" });
    await fact(forSara, anna.userId, trip, "involves", saraNode);
    await fact(forSara, anna.userId, trip, "involves", annaInSara);
    await fact(forSara, anna.userId, annaInSara, "knows", saraNode);
    await fact(forSara, anna.userId, cafe, "about", saraNode);
    log.push(`ensured "For Sara" (shared with Sara as editor) and "Work" content`);
  });

  console.log(["Seeded the demo household:", ...log.map((l) => `  - ${l}`),
    `Sign in as anna@example.com / ${PASSWORD} (children: emma, noah — their new devices need a parent's approval).`,
    `Sara (another household, sees only "For Sara" and her own Personal graph): ${SARA.email} / ${PASSWORD}.`].join("\n"));
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("Seeding failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
