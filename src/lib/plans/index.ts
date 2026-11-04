/**
 * CONTRACT: subscription tiers and feature gating. Owned by the tiers/admin workstream; signatures fixed.
 * Public tiers (free, plus, family …) and the hidden "ultimate" tier with sub-items (practice_psychology,
 * practice_medical, insights …). Ultimate and its sub-items are never shown on public surfaces; only the platform
 * admin (PLATFORM_ADMIN_EMAILS, default the founder's address) sees and assigns them. Gate on the server.
 */
import type { Viewer } from "@/lib/auth";

export type Feature = "insights" | "practice_psychology" | "practice_medical" | "admin_console" | (string & {});

const ADMINS = (process.env.PLATFORM_ADMIN_EMAILS ?? "rummand@gmail.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** The founder/platform admin: sees Ultimate, its sub-items and the admin console. */
export function isPlatformAdmin(v: Pick<Viewer, "email">): boolean {
  return ADMINS.includes(v.email.toLowerCase());
}

/** Stub until the tiers workstream lands: everything on in development, platform admin only in production. */
export async function hasFeature(v: Viewer, _feature: Feature): Promise<boolean> {
  return process.env.NODE_ENV !== "production" || isPlatformAdmin(v);
}
