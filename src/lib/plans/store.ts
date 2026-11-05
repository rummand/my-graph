/** Plan storage (server-only, no Next imports so scripts can use it). See catalog.ts for the model. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { accountAddons, accountPlans, planFeatures, plans, users } from "@/db/schema";
import { sweepDueBilling } from "@/lib/billing/store";
import {
  ADDON_KEYS, PLAN_CATALOG, ULTIMATE, canGrantAddon, effectivePlan, emailIsAdmin, isAddon, parseAdminEmails, resolveFeatures,
} from "./catalog";

export type Entitlements = {
  planKey: string;
  planName: string;
  /** True when the plan comes from the household owner rather than the person's own account. */
  inherited: boolean;
  features: Set<string>;
  /** Add-ons granted to this account (whether or not they currently count). */
  addons: string[];
  isAdmin: boolean;
};

export function adminEmails(): string[] {
  return parseAdminEmails(process.env.PLATFORM_ADMIN_EMAILS);
}

const g = globalThis as unknown as { __mgPlanCatalog?: Promise<void> | null; __mgPlanAdmins?: Set<string> };

/** Fill in any built-in plan or plan feature missing from the database (idempotent; never overwrites). */
export function ensureCatalog(): Promise<void> {
  if (!g.__mgPlanCatalog) {
    g.__mgPlanCatalog = (async () => {
      await db.insert(plans).values(PLAN_CATALOG.map((p) => ({ key: p.key, name: p.name, public: p.public, sort: p.sort, description: p.description })))
        .onConflictDoNothing();
      await db.insert(planFeatures).values(PLAN_CATALOG.flatMap((p) => p.features.map((feature) => ({ planKey: p.key, feature }))))
        .onConflictDoNothing();
    })().catch((err) => {
      g.__mgPlanCatalog = null; // try again next time
      throw err;
    });
  }
  return g.__mgPlanCatalog;
}

/** "Me as owner … is in the ultimate subscription": put a platform admin on Ultimate with every add-on. */
export async function ensureAdminEntitlements(userId: string): Promise<void> {
  const seen = (g.__mgPlanAdmins ??= new Set());
  if (seen.has(userId)) return;
  await ensureCatalog();
  await db.insert(accountPlans).values({ userId, planKey: ULTIMATE })
    .onConflictDoUpdate({ target: accountPlans.userId, set: { planKey: ULTIMATE, assignedAt: new Date() }, setWhere: sql`${accountPlans.planKey} <> ${ULTIMATE}` });
  await db.insert(accountAddons).values(ADDON_KEYS.map((addon) => ({ userId, addon }))).onConflictDoNothing();
  seen.add(userId);
}

/** Every platform admin that has an account: Ultimate with all add-ons. Called on server start. */
export async function ensurePlatformAdmins(): Promise<number> {
  const emails = adminEmails();
  if (!emails.length) return 0;
  const rows = await db.select({ id: users.id }).from(users).where(inArray(sql`lower(${users.email})`, emails));
  for (const r of rows) await ensureAdminEntitlements(r.id);
  return rows.length;
}

export async function listPlans() {
  await ensureCatalog();
  const [rows, feats] = await Promise.all([
    db.select().from(plans).orderBy(asc(plans.sort)),
    db.select().from(planFeatures),
  ]);
  return rows.map((p) => ({ ...p, features: feats.filter((f) => f.planKey === p.key).map((f) => f.feature).sort() }));
}
export type PlanWithFeatures = Awaited<ReturnType<typeof listPlans>>[number];

/** Resolve an account's plan, add-ons and features from the database. */
export async function loadEntitlements(u: { id: string; householdId: string; email: string }): Promise<Entitlements> {
  const isAdmin = emailIsAdmin(u.email, adminEmails());
  if (isAdmin) await ensureAdminEntitlements(u.id);
  else await ensureCatalog();
  // Paid plans whose downgrade hold or failed-payment grace ran out change here (billing writes account_plans).
  await sweepDueBilling().catch((err) => console.error("[plans] billing sweep", err instanceof Error ? err.message : err));
  const [[own], addonRows] = await Promise.all([
    db.select({ planKey: accountPlans.planKey }).from(accountPlans).where(eq(accountPlans.userId, u.id)).limit(1),
    db.select({ addon: accountAddons.addon }).from(accountAddons).where(eq(accountAddons.userId, u.id)),
  ]);
  let ownerPlan: string | null = null;
  if (!own) {
    const [o] = await db.select({ planKey: accountPlans.planKey }).from(accountPlans)
      .innerJoin(users, eq(users.id, accountPlans.userId))
      .where(and(eq(users.householdId, u.householdId), eq(users.role, "owner"))).limit(1);
    ownerPlan = o?.planKey ?? null;
  }
  const eff = effectivePlan(own?.planKey, ownerPlan);
  const [[plan], feats] = await Promise.all([
    db.select({ name: plans.name }).from(plans).where(eq(plans.key, eff.key)).limit(1),
    db.select({ feature: planFeatures.feature }).from(planFeatures).where(eq(planFeatures.planKey, eff.key)),
  ]);
  const addons = addonRows.map((a) => a.addon).filter(isAddon);
  return {
    planKey: eff.key, planName: plan?.name ?? eff.key, inherited: eff.inherited, addons, isAdmin,
    features: resolveFeatures({ planKey: eff.key, inherited: eff.inherited, planFeatures: feats.map((f) => f.feature), addons, isAdmin }),
  };
}

export class PlanError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** Put an account on a plan. Leaving Ultimate keeps the add-on rows (they stop counting) so moving back restores them. */
export async function setAccountPlan(userId: string, planKey: string, by: string): Promise<{ from: string | null }> {
  await ensureCatalog();
  const [p] = await db.select({ key: plans.key }).from(plans).where(eq(plans.key, planKey)).limit(1);
  if (!p) throw new PlanError(400, "There is no plan with that name.");
  const [before] = await db.select({ planKey: accountPlans.planKey }).from(accountPlans).where(eq(accountPlans.userId, userId)).limit(1);
  await db.insert(accountPlans).values({ userId, planKey, assignedBy: by })
    .onConflictDoUpdate({ target: accountPlans.userId, set: { planKey, assignedBy: by, assignedAt: new Date() } });
  return { from: before?.planKey ?? null };
}

/** Turn one of Ultimate's sub-items on or off for an account (only on Ultimate). */
export async function setAccountAddon(userId: string, addon: string, on: boolean, by: string): Promise<void> {
  if (!isAddon(addon)) throw new PlanError(400, "That add-on doesn't exist.");
  if (on) {
    const [own] = await db.select({ planKey: accountPlans.planKey }).from(accountPlans).where(eq(accountPlans.userId, userId)).limit(1);
    if (!canGrantAddon(own?.planKey ?? "", addon)) throw new PlanError(409, "Move this account to Ultimate first. Add-ons only work on Ultimate.");
    await db.insert(accountAddons).values({ userId, addon, grantedBy: by }).onConflictDoNothing();
  } else {
    await db.delete(accountAddons).where(and(eq(accountAddons.userId, userId), eq(accountAddons.addon, addon)));
  }
}
