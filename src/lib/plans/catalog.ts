/**
 * Plans and add-ons (pure: no Next, no DB, so tests and scripts can use it).
 *
 * Model
 * - A plan belongs to one user account (`account_plans`). A household member without their own plan inherits the
 *   household owner's plan for the shared features of that plan. Add-ons are personal and never inherit: the
 *   practice tools belong to the licensed person they were granted to.
 * - "ultimate" is hidden (`public = false`): it never shows as an option on public surfaces (pricing, onboarding,
 *   the settings plan list) for anyone but the platform admin. A person who has it sees it as their own plan.
 * - Ultimate's sub-items are add-ons that can only be granted on Ultimate: practice_psychology, practice_medical,
 *   insights. An add-on row on an account that is no longer on Ultimate is kept but does nothing.
 * - "admin_console" is never a plan feature; it is exactly isPlatformAdmin.
 * - Payments: `plans.stripe_price_id` is the seam (null today). Billing would set account_plans from a webhook.
 */

export const ULTIMATE = "ultimate";
export const DEFAULT_PLAN = "free";
/** What a household member of an Ultimate owner gets: the top public plan. */
export const INHERITED_FROM_ULTIMATE = "family";

export type PlanSeed = { key: string; name: string; public: boolean; sort: number; description: string; features: string[] };

const BASE = ["assistant", "library"];
const PLUS = [...BASE, "multiple_graphs", "documents", "web_reading"];
const FAMILY = [...PLUS, "family_members", "shared_graphs", "corpora"];

/** The built-in catalog (the plans_admin migration seeds the same rows; ensureCatalog fills any that are missing). */
export const PLAN_CATALOG: PlanSeed[] = [
  { key: "free", name: "Free", public: true, sort: 10, description: "One household graph, the library and the assistant.", features: BASE },
  { key: "plus", name: "Plus", public: true, sort: 20, description: "More graphs, Documents and web reading.", features: PLUS },
  { key: "family", name: "Family", public: true, sort: 30, description: "Everything in Plus, for the whole household, with shared graphs and corpora.", features: FAMILY },
  { key: ULTIMATE, name: "Ultimate", public: false, sort: 100, description: "Everything, plus the add-ons granted to this account.", features: [...FAMILY, "priority_support"] },
];

/** Ultimate's sub-items. `practice` ones form the Practice group in the admin console. */
export const ADDONS = [
  { key: "practice_psychology", group: "practice" },
  { key: "practice_medical", group: "practice" },
  { key: "insights", group: "insights" },
] as const;
export type AddonKey = (typeof ADDONS)[number]["key"];
export const ADDON_KEYS: string[] = ADDONS.map((a) => a.key);

export function isAddon(x: string): x is AddonKey {
  return ADDON_KEYS.includes(x);
}

/** Add-ons can only be granted to (and only count on) an account on Ultimate. */
export function canGrantAddon(planKey: string, addon: string): boolean {
  return planKey === ULTIMATE && isAddon(addon);
}

/** Platform admins from a comma-separated list (PLATFORM_ADMIN_EMAILS), lower-cased. */
export function parseAdminEmails(raw: string | undefined | null): string[] {
  return (raw ?? "rummand@gmail.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function emailIsAdmin(email: string | null | undefined, admins: string[]): boolean {
  return !!email && admins.includes(email.trim().toLowerCase());
}

/** Which plan applies: the person's own, else their household owner's, else Free. */
export function effectivePlan(own: string | null | undefined, householdOwner: string | null | undefined): { key: string; inherited: boolean } {
  if (own) return { key: own, inherited: false };
  // Ultimate is personal and hidden: household members of an Ultimate owner get the top public plan, never its name.
  if (householdOwner === ULTIMATE) return { key: INHERITED_FROM_ULTIMATE, inherited: true };
  if (householdOwner) return { key: householdOwner, inherited: true };
  return { key: DEFAULT_PLAN, inherited: false };
}

/**
 * Every feature an account has: its plan's features, its add-ons when the plan is Ultimate (personal add-ons only:
 * an inherited Ultimate brings the plan features, not the owner's add-ons), and the admin console for platform admins
 * (who also always have every add-on).
 */
export function resolveFeatures(i: {
  planKey: string; inherited?: boolean; planFeatures: string[]; addons: string[]; isAdmin: boolean;
}): Set<string> {
  const out = new Set(i.planFeatures);
  if (i.planKey === ULTIMATE && !i.inherited) for (const a of i.addons) if (isAddon(a)) out.add(a);
  if (i.isAdmin) {
    out.add("admin_console");
    for (const a of ADDON_KEYS) out.add(a);
  } else {
    out.delete("admin_console");
  }
  return out;
}

export type PlanRow = { key: string; name: string; public: boolean; sort: number; description?: string | null };

/**
 * Plans that may be offered as options on a surface (settings plan list, pricing, onboarding, the admin picker).
 * Hidden plans only for the platform admin. The viewer's own plan is shown separately, never as an option.
 */
export function visiblePlans<T extends PlanRow>(rows: T[], opts: { isAdmin: boolean }): T[] {
  return rows.filter((p) => p.public || opts.isAdmin).sort((a, b) => a.sort - b.sort);
}

/** Add-ons a viewer may see at all: the admin sees every one; others only the ones they actually have. */
export function visibleAddons(have: string[], opts: { isAdmin: boolean }): string[] {
  return opts.isAdmin ? [...ADDON_KEYS] : ADDON_KEYS.filter((a) => have.includes(a));
}
