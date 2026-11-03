/** Route-handler helpers shared by /api/people and /api/meta: auth, zod parsing and consistent JSON errors. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { isParent, requireUser, type Viewer } from "@/lib/auth";
import { PeopleError } from "./writes";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export const uuid = z.uuid("That id isn't valid");

/** Parse a JSON body with a zod schema; 400 with field issues when it doesn't fit. */
export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new HttpError(400, "Send a JSON body"); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "Some fields need fixing", { fields: r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message })) });
  return r.data;
}

export function query<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const r = schema.safeParse(params);
  if (!r.success) throw new HttpError(400, "Invalid query", { fields: r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message })) });
  return r.data;
}

export function requireParent(v: Viewer) {
  if (!isParent(v)) throw new HttpError(403, "Only parents can change this");
  // The model belongs to the household whose graph is open: only that household's parents change it.
  if (v.graphHouseholdId !== v.householdId) throw new HttpError(403, "This graph uses its owner's household model. Only they can change it.");
}

/** Wrap a handler: resolves the viewer, maps thrown errors to `{ error }` JSON with the right status. */
export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUser();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof Response) return e;
  if (e instanceof HttpError || e instanceof PeopleError) {
    return NextResponse.json({ error: e.message, ...(e.details ? e.details as object : {}) }, { status: e.status });
  }
  const status = (e as { status?: unknown })?.status;
  if (e instanceof Error && typeof status === "number" && status >= 400 && status < 500) {
    return NextResponse.json({ error: e.message }, { status });
  }
  console.error("[people api]", e);
  return NextResponse.json({ error: "Something went wrong on our side. Try again in a moment." }, { status: 500 });
}
