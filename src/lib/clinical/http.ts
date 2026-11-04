/** Route plumbing for /api/clinical: the signed-in viewer, zod bodies, JSON errors in the reader's language. */
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { GBrainError } from "@/lib/gbrain";
import { getT } from "@/lib/i18n";
import { ClinicalError } from "./access";

export const uuid = z.string().uuid();

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 500_000) throw new ClinicalError(413, "clinical.err.tooLong");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ClinicalError) throw e;
    throw new ClinicalError(400, "clinical.err.badJson");
  }
  return schema.parse(raw);
}

export function parseParam<T extends z.ZodType>(value: unknown, schema: T): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ClinicalError(404, "clinical.err.notFound");
  return r.data;
}

/** A signed-in route; ClinicalErrors become JSON `{ error, code? }` translated for the reader. */
export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      const t = await getT().catch(() => null);
      if (e instanceof ClinicalError) {
        const vars = { ...e.vars, ...(e.vars.purpose && t ? { what: t(`clinical.purposeWhat.${e.vars.purpose}`) } : {}) };
        return NextResponse.json({ error: t ? t(e.key, vars) : e.key, ...(e.code ? { code: e.code, purpose: e.vars.purpose } : {}) }, { status: e.status });
      }
      if (e instanceof ZodError) return NextResponse.json({ error: e.issues[0]?.message ?? "Some fields need fixing." }, { status: 400 });
      if (e instanceof GBrainError) return NextResponse.json({ error: e.message }, { status: e.status });
      console.error("[clinical api]", e);
      return NextResponse.json({ error: t ? t("clinical.err.server") : "Something went wrong on our side. Please try again." }, { status: 500 });
    }
  };
}
