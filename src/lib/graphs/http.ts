/** Route-handler plumbing for /api/graphs and /api/invites: JSON errors, zod parsing, the graph cookie, rate limits. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { AuthError } from "@/lib/auth/http";
import { secureCookies } from "@/lib/auth/constants";
import { AttemptLimiter } from "@/lib/auth/rate-limit";
import { GRAPH_COOKIE } from "./pure";
import { GraphError } from "./index";

export function errorJson(status: number, error: string, extra?: Record<string, unknown>, headers?: HeadersInit) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status, headers });
}

export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new GraphError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message }));
    throw new GraphError(400, fields[0]?.message ?? "Some fields need fixing.", { fields });
  }
  return r.data;
}

export function parseParam<T extends z.ZodType>(value: unknown, schema: T, notFound = "Not found."): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new GraphError(404, notFound);
  return r.data;
}

/** Map thrown Responses, GraphErrors and AuthErrors to JSON; anything else is a 500 that doesn't leak details. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof GraphError) return errorJson(e.status, e.message, e.extra);
    if (e instanceof AuthError) return errorJson(e.status, e.message, e.extra);
    console.error("[graphs api]", e);
    return errorJson(500, "Something went wrong on our side. Please try again.");
  }
}

/** A signed-in route: resolves the viewer, then runs `fn`; plain values are sent as JSON. */
export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return (req: Request, ctx: C) => handle(async () => {
    const v = await requireUserApi();
    const out = await fn(req, v, ctx);
    return out instanceof Response ? out : NextResponse.json(out);
  });
}

export function graphCookieOptions(env?: { NODE_ENV?: string; APP_URL?: string }) {
  return { httpOnly: true, secure: secureCookies(env), sameSite: "lax" as const, path: "/", maxAge: 400 * 24 * 60 * 60 };
}

export function setGraphCookie(res: NextResponse, graphId: string): NextResponse {
  res.cookies.set(GRAPH_COOKIE, graphId, graphCookieOptions());
  return res;
}

/** The public origin for links we hand out (APP_URL when set, else the request's own host). */
export function publicOrigin(req: Request): string {
  const app = process.env.APP_URL?.replace(/\/$/, "");
  if (app) return app;
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

const g = globalThis as unknown as { __mgInviteCreate?: AttemptLimiter; __mgInviteAccept?: AttemptLimiter; __mgInviteLookup?: AttemptLimiter };
/** Invites one person may send: 20 an hour. */
export const inviteCreateLimiter = g.__mgInviteCreate ?? (g.__mgInviteCreate = new AttemptLimiter(20, 60 * 60 * 1000));
/** Invite accept attempts per client: 10 per 15 minutes. */
export const inviteAcceptLimiter = g.__mgInviteAccept ?? (g.__mgInviteAccept = new AttemptLimiter(10, 15 * 60 * 1000));
/** Invite link look-ups per client: 60 per 15 minutes. */
export const inviteLookupLimiter = g.__mgInviteLookup ?? (g.__mgInviteLookup = new AttemptLimiter(60, 15 * 60 * 1000));

/** Count one attempt; throws 429 when the limit is reached. */
export function limit(l: AttemptLimiter, key: string): void {
  const c = l.check(key);
  if (!c.allowed) {
    const minutes = Math.ceil(c.retryAfterSec / 60);
    throw new GraphError(429, `Too many attempts. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`, { retryAfterSec: c.retryAfterSec });
  }
  l.fail(key);
}

/* ── Request bodies ──────────────────────────────────────────────────────────────────────────────────── */

const name = z.string().trim().min(1, "Give the graph a name.").max(60, "Keep the name under 60 characters.");
const description = z.string().trim().max(400, "Keep the description under 400 characters.").nullish().transform((s) => (s ? s : null));
const hue = z.number().int().min(0).max(359);
const kind = z.enum(["personal", "work", "partner", "project", "shared", "other", "practice"]);
/** Graph kinds only some plans may make (a clinical practice). Check `hasFeature` before creating one of these. */
export const GATED_GRAPH_KINDS = ["practice"] as const;

/** Refuses a gated graph kind (404-style: the kind doesn't exist) for an account whose plan doesn't include it. */
export async function requireKindAllowed(v: Viewer, kind: string | undefined): Promise<void> {
  if (!kind || !(GATED_GRAPH_KINDS as readonly string[]).includes(kind)) return;
  const { hasFeature } = await import("@/lib/plans");
  if (!(await hasFeature(v, "practice_psychology")) && !(await hasFeature(v, "practice_medical"))) {
    throw new GraphError(400, "That kind of graph isn't available.", { fields: [{ key: "kind", message: "Not available." }] });
  }
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = z.string().trim().toLowerCase().max(254).refine((s) => EMAIL.test(s), "Enter a valid email address.");
const memberRole = z.enum(["editor", "viewer"]);

export const uuid = z.string().uuid();
export const createGraphBody = z.object({ name, description: description.optional(), kind: kind.default("other"), color: hue.optional() });
export const updateGraphBody = z.object({ name: name.optional(), description: description.optional(), kind: kind.optional(), color: hue.optional() })
  .refine((b) => Object.keys(b).length > 0, "Nothing to change.");
export const switchBody = z.object({ graphId: uuid });
export const addMemberBody = z.object({ email, role: memberRole.default("editor") });
export const changeMemberBody = z.object({ role: memberRole });
export const inviteBody = z.object({ email, role: memberRole.default("editor") });
export const acceptBody = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80).optional(),
  password: z.string().max(1000).optional(),
});
