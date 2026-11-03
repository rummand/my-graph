/**
 * Demo household (idempotent): `npm run db:seed` / `npx tsx scripts/seed.ts`.
 *   Owner   anna@example.com   / demo-demo-demo
 *   Parent  mikkel@example.com / demo-demo-demo
 *   Child   emma (born 2016)   / demo-demo-demo
 *   Child   noah (born 2019)   / demo-demo-demo
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

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, sql } = await import("@/db");
  const { households, users } = await import("@/db/schema");
  const { createAccount, createPersonNode, linkParentOf } = await import("@/lib/auth/members");
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
  });

  console.log(["Seeded the demo household:", ...log.map((l) => `  - ${l}`),
    `Sign in as anna@example.com / ${PASSWORD} (children: emma, noah — their new devices need a parent's approval).`].join("\n"));
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("Seeding failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
