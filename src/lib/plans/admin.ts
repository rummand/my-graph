/** Platform admin guards for pages and route handlers (server-only). */
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { getViewer, requireUser, type Viewer } from "@/lib/auth";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { adminGate, adminLimiter } from "./admin-guard";
import { isPlatformAdmin } from "./index";
import { AuthError } from "@/lib/auth/http";
import { PlanError, adminEmails, ensureAdminEntitlements } from "./store";

/** Pages under /admin: the platform admin, or a 404 for everyone else. */
export async function requirePlatformAdmin(): Promise<Viewer> {
  const v = await requireUser();
  if (!isPlatformAdmin(v)) notFound();
  await ensureAdminEntitlements(v.id).catch((err) => console.error("[admin] ensure Ultimate", err));
  return v;
}

/**
 * Route handlers under /api/admin: platform admin only (404 otherwise, signed in or not), same-site origin on
 * changes (CSRF), and a per-admin rate limit. Throws a JSON Response when refused.
 */
export async function requirePlatformAdminApi(req: Request): Promise<Viewer> {
  const v = await getViewer();
  const gate = adminGate({
    viewer: v, admins: adminEmails(), method: req.method, limiter: adminLimiter,
    origin: {
      origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"), appUrl: process.env.APP_URL,
    },
  });
  if (!gate.ok) {
    throw NextResponse.json({ error: gate.error }, {
      status: gate.status, headers: gate.retryAfterSec ? { "Retry-After": String(gate.retryAfterSec) } : undefined,
    });
  }
  return v!;
}

/**
 * Every admin action goes to the audit log, filed under the admin's household with their id. Unlike ordinary audit
 * writes this one is not best-effort: if it can't be written the request fails, so no admin action goes unrecorded.
 */
export async function auditAdmin(admin: Pick<Viewer, "id" | "householdId" | "email">, action: `admin.${string}`, target: { type: string; id: string }, meta: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({
    householdId: admin.householdId, userId: admin.id, action, targetType: target.type, targetId: target.id,
    meta: { ...meta, adminId: admin.id, adminEmail: admin.email },
  });
}

/** Runs an admin route handler: thrown Responses pass through, plan and auth errors become JSON `{ error }`. */
export async function adminHandle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof PlanError || e instanceof AuthError) return NextResponse.json({ error: e.message, ...(e instanceof AuthError ? e.extra : {}) }, { status: e.status });
    console.error("[admin api]", e);
    return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 });
  }
}

/** The public base URL for links the admin copies (APP_URL, else the address this request came in on). */
export function publicBaseUrl(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}
