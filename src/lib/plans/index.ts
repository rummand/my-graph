/**
 * CONTRACT: subscription tiers and feature gating. Owned by the tiers/admin workstream; signatures fixed.
 * Public tiers (free, plus, family …) and the hidden "ultimate" tier with sub-items (practice_psychology,
 * practice_medical, insights …). Ultimate and its sub-items are never shown on public surfaces; only the platform
 * admin (PLATFORM_ADMIN_EMAILS, default the founder's address) sees and assigns them. Gate on the server.
 *
 * Plans are per user account; household members without their own plan inherit the owner's plan features (an Ultimate
 * owner's members get Family; never the
 * owner's add-ons). See catalog.ts for the whole model and store.ts for storage.
 *
 * Development: features stay on for everyone (so other workstreams can build) unless PLANS_ENFORCE=1.
 * "admin_console" is always exactly isPlatformAdmin, in every environment.
 */
import { cache } from "react";
import type { Viewer } from "@/lib/auth";
import { emailIsAdmin, parseAdminEmails } from "./catalog";
import { loadEntitlements, type Entitlements } from "./store";

export type Feature = "insights" | "practice_psychology" | "practice_medical" | "admin_console" | (string & {});
export type { Entitlements } from "./store";

/** The founder/platform admin: sees Ultimate, its sub-items and the admin console. */
export function isPlatformAdmin(v: Pick<Viewer, "email">): boolean {
  return emailIsAdmin(v.email, parseAdminEmails(process.env.PLATFORM_ADMIN_EMAILS));
}

/** Plans are enforced in production, and in development when PLANS_ENFORCE=1. */
export function plansEnforced(env: { NODE_ENV?: string; PLANS_ENFORCE?: string } = process.env): boolean {
  return env.NODE_ENV === "production" || env.PLANS_ENFORCE === "1";
}

/** One resolution per account per request (React cache). */
const entitlementsFor = cache(async (id: string, householdId: string, email: string): Promise<Entitlements | null> => {
  try {
    return await loadEntitlements({ id, householdId, email });
  } catch (err) {
    console.error("[plans] could not resolve the plan", err instanceof Error ? err.message : err);
    return null;
  }
});

/** The viewer's plan, add-ons and features (null if the plan tables can't be read). */
export async function getEntitlements(v: Pick<Viewer, "id" | "householdId" | "email">): Promise<Entitlements | null> {
  return entitlementsFor(v.id, v.householdId, v.email);
}

/** Whether this person may use a feature. Resolved on the server from their plan and add-ons. */
export async function hasFeature(v: Viewer, feature: Feature): Promise<boolean> {
  if (feature === "admin_console") return isPlatformAdmin(v);
  if (!plansEnforced()) return true;
  const e = await getEntitlements(v);
  if (!e) return isPlatformAdmin(v); // plan tables unreadable: fail closed for everyone but the admin
  return e.features.has(feature);
}
