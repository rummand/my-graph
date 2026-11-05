/** Small helpers for the /api/devices route handlers (server-only). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { enabledDisciplines } from "@/lib/clinical/access";
import type { Viewer } from "@/lib/auth";
import { pushEnabled } from "./config";
import { formatClock, isDeviceToken, parseClock } from "./pure";
import { getPrefs, type PushPrefs } from "./store";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[push] route failed:", err instanceof Error ? err.message : err);
    return jsonError(500, "Something went wrong on our side. Please try again.");
  }
}

export async function readJson(req: Request): Promise<unknown | null> {
  try {
    const text = await req.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

export function firstIssue(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Check what you sent and try again.";
}

const token = z.string().trim().refine(isDeviceToken, "That isn't an iPhone notification token.");

export const registerSchema = z.object({
  token,
  platform: z.literal("ios").default("ios"),
  environment: z.enum(["sandbox", "production"]).nullish(),
  appVersion: z.string().trim().max(40).nullish(),
  locale: z.enum(["en", "da"]).nullish(),
}).strict();

export const unregisterSchema = z.object({ token: token.optional() }).strict();

const clock = z.string().trim().nullable().refine((s) => s === null || s === "" || parseClock(s) !== null, "Write the time as HH:MM, for example 22:00.");

export const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  categories: z.object({
    reminders: z.boolean(), waiting: z.boolean(), connections: z.boolean(), clinical: z.boolean(),
  }).partial().strict().optional(),
  quietHours: z.object({ start: clock, end: clock }).nullable().optional(),
}).strict();

/** What the app needs to decide: does the server push, and does it push reminders (then the app stops its own)? */
export async function pushStatus(v: Viewer, prefs?: PushPrefs) {
  const p = prefs ?? (await getPrefs(v.id));
  const on = pushEnabled();
  return { push: on, remindersByPush: on && p.enabled && p.categories.reminders };
}

export async function settingsView(v: Viewer, prefs?: PushPrefs) {
  const p = prefs ?? (await getPrefs(v.id));
  const practice = (await enabledDisciplines(v).catch(() => [])).length > 0;
  return {
    ...(await pushStatus(v, p)),
    settings: {
      enabled: p.enabled,
      categories: { reminders: p.categories.reminders, waiting: p.categories.waiting, connections: p.categories.connections, ...(practice ? { clinical: p.categories.clinical } : {}) },
      quietHours: p.quietStart != null && p.quietEnd != null ? { start: formatClock(p.quietStart), end: formatClock(p.quietEnd) } : null,
    },
    practice,
  };
}
