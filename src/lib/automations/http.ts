/**
 * Route plumbing for /api/automations, /api/suggestions, /api/activity, /api/recipes and /api/assistant-settings:
 * the viewer, zod parsing and JSON errors. CSRF (same-origin) is enforced for every state-changing /api request by
 * middleware (src/middleware.ts); handlers here only run after it passed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { canCreateAssistantWork, canUseAssistantTools } from "./policy";
import { AutomationError } from "./store";

export function errorJson(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status });
}

export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 100_000) throw new AutomationError(400, "That request is too large.");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof AutomationError) throw e;
    throw new AutomationError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AutomationError(400, r.error.issues[0]?.message ?? "Some fields need fixing.");
  return r.data;
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = schema.safeParse(params);
  if (!r.success) throw new AutomationError(400, r.error.issues[0]?.message ?? "Some parameters need fixing.");
  return r.data;
}

const uuid = z.uuid();
export function parseId(value: unknown, what = "That item"): string {
  const r = uuid.safeParse(value);
  if (!r.success) throw new AutomationError(404, `${what} doesn't exist.`);
  return r.data;
}

/** A signed-in route for the assistant's tools: children and guests get 403; `write` also refuses graph viewers. */
export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>, opts: { write?: boolean } = {}) {
  return async (req: Request, ctx: C) => {
    try {
      const v = await requireUserApi();
      if (!canUseAssistantTools(v)) return errorJson(403, "This part of My Graph is for parents.");
      if (opts.write && !canCreateAssistantWork(v)) return errorJson(403, "You can look at this graph but not change the assistant's work in it.");
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof AutomationError) return errorJson(e.status, e.message);
      const status = (e as { status?: unknown })?.status;
      if (typeof status === "number" && status >= 400 && status < 500 && e instanceof Error) return errorJson(status, e.message);
      console.error("[automations api]", e);
      return errorJson(500, "Something went wrong on our side. Please try again.");
    }
  };
}

/* ── Bodies ──────────────────────────────────────────────────────────────────────────────────────────── */

const name = z.string().trim().min(1, "Give it a name.").max(80, "Keep the name under 80 characters.");
const prompt = z.string().trim().max(4000, "Keep the instructions under 4,000 characters.");
const visibility = z.enum(["private", "parents", "household"]);

export const automationCreateBody = z.object({
  name, prompt: prompt.optional(), recipeId: uuid.nullish(), trigger: z.enum(["schedule", "condition"]),
  config: z.record(z.string(), z.unknown()), oneShot: z.boolean().optional(), enabled: z.boolean().optional(),
}).strict();

export const automationPatchBody = z.object({
  name: name.optional(), prompt: prompt.optional(), recipeId: uuid.nullable().optional(), trigger: z.enum(["schedule", "condition"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(), oneShot: z.boolean().optional(), enabled: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

export const heartbeatBody = z.object({
  enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((b) => b.enabled !== undefined || b.config !== undefined, "Nothing to change.");

export const previewBody = z.object({
  trigger: z.enum(["schedule", "condition", "heartbeat"]), config: z.record(z.string(), z.unknown()),
}).strict();

export const decisionBody = z.object({ decision: z.enum(["approve", "always", "deny"]) }).strict();

export const suggestionsQuery = z.object({
  status: z.enum(["pending", "all"]).default("pending"), limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), subjectId: uuid.optional(), runId: uuid.optional(),
});

export const settingsPatchBody = z.object({
  autoSaveMemories: z.boolean().optional(),
  alwaysAllow: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  capabilities: z.partialRecord(z.enum(["library", "timeline", "people", "wiki_write", "reminders", "web"]), z.boolean()).optional(),
  tone: z.enum(["warm", "brief", "detailed"]).optional(),
  dailySuggestionCap: z.number().int().min(0, "Use 0 or more.").max(50, "Keep it at 50 or fewer a day.").optional(),
  onboarded: z.literal(true).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

export const recipeCreateBody = z.object({
  name, description: z.string().trim().max(300).optional(), prompt: prompt.min(5, "Write what the recipe should do."), visibility: visibility.optional(),
}).strict();
export const recipePatchBody = z.object({
  name: name.optional(), description: z.string().trim().max(300).optional(), prompt: prompt.min(5).optional(), visibility: visibility.optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");
export const recipeRunBody = z.object({ values: z.record(z.string().max(40), z.string().max(200)).optional() }).strict();
