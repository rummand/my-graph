/** Route plumbing for /api/artifacts and /api/design-sets: zod parsing, JSON errors, the signed-in viewer. */
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { DesignSetError } from "@/lib/design-sets";
import { SiteReadError } from "@/lib/design-sets/fetch-site";
import { ARTIFACT_KINDS } from "@/lib/design-sets/tokens";
import { ArtifactError } from "./index";

export function errorJson(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status });
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 2_000_000) throw new ArtifactError(400, "That request is too large.");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ArtifactError) throw e;
    throw new ArtifactError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message }));
    throw new ArtifactError(400, fields[0]?.message ?? "Some fields need fixing.", { fields });
  }
  return r.data;
}

export function parseId(value: unknown): string {
  const r = z.string().uuid().safeParse(value);
  if (!r.success) throw new ArtifactError(404, "That artifact isn't here.");
  return r.data;
}

export function apiRoute<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof ArtifactError || e instanceof DesignSetError) return errorJson(e.status, e.message, e.extra);
      if (e instanceof SiteReadError) return errorJson(e.status, e.message);
      if (e instanceof ZodError) return errorJson(400, e.issues[0]?.message ?? "Some fields need fixing.");
      console.error("[artifacts api]", e);
      return errorJson(500, "Something went wrong on our side. Please try again.");
    }
  };
}

/* ── Bodies ─────────────────────────────────────────────────────────────────────────────────────────── */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-03-01.");

export const sourceQuerySchema = z.object({
  about: z.array(z.object({ nodeId: z.string().uuid(), label: z.string().trim().min(1).max(200) })).max(8).default([]),
  question: z.string().trim().max(1000).default(""),
  from: ymd.nullish(),
  to: ymd.nullish(),
  text: z.string().max(2000).default(""),
});

export const visibilitySchema = z.enum(["private", "parents", "household"]);
const setId = z.string().trim().min(1).max(64);

export const createArtifactBody = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().trim().min(1, "Give it a title.").max(200),
  query: sourceQuerySchema.default({ about: [], question: "", text: "" }),
  designSetId: setId.nullish(),
  blank: z.boolean().default(false),
});

export const patchArtifactBody = z.object({
  title: z.string().trim().min(1, "Give it a title.").max(200).optional(),
  content: z.unknown().optional(),
  designSetId: setId.optional(),
  visibility: visibilitySchema.optional(),
  baseVersion: z.number().int().min(0).optional(),
});

export const publishBody = z.object({ visibility: visibilitySchema.default("household") });
export const regenBody = z.object({ instruction: z.string().trim().max(500).optional() });
export const acceptBody = z.object({ section: z.unknown(), citations: z.unknown(), baseVersion: z.number().int().min(0).optional() });

export const designSetBody = z.object({
  name: z.string().trim().min(1, "Give the design set a name.").max(80),
  description: z.string().trim().max(300).nullish(),
  tokens: z.unknown(),
  templates: z.unknown().optional(),
  sourceUrl: z.string().url().max(500).nullish(),
});
export const designSetPatch = designSetBody.partial();
export const fromUrlBody = z.object({ url: z.string().trim().min(3, "Type a web address.").max(500) });
export const defaultBody = z.object({ designSetId: setId });
