/**
 * Devices and push settings (server-only). A device belongs to the person who registered it and to the session it
 * registered from: signing out deletes the session, and the device with it.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistantSettings, deviceTokens, pushDeliveries, pushSettings, users } from "@/db/schema";
import { DEFAULT_DAILY_CAP, PUSH_CATEGORIES, localDay, type PushCategory } from "./pure";

export type DeviceInput = {
  token: string;
  platform: "ios";
  environment?: "sandbox" | "production" | null;
  appVersion?: string | null;
  locale?: string | null;
};

/**
 * Registers (or refreshes) a device token for this person and session. A token that moved to another person (a
 * shared iPad, a new sign-in) is taken over: one token, one person.
 */
export async function registerDevice(userId: string, sessionId: string | null, input: DeviceInput): Promise<{ id: string }> {
  const now = new Date();
  const [row] = await db.insert(deviceTokens).values({
    userId, sessionId, token: input.token.toLowerCase(), platform: input.platform,
    environment: input.environment ?? null, appVersion: input.appVersion ?? null, locale: input.locale ?? null,
    createdAt: now, lastSeenAt: now,
  }).onConflictDoUpdate({
    target: deviceTokens.token,
    set: {
      userId, sessionId, platform: input.platform, environment: input.environment ?? null,
      appVersion: input.appVersion ?? null, locale: input.locale ?? null, lastSeenAt: now,
      // A token taken over by someone else starts fresh (no old reminders pushed to them).
      createdAt: sql`case when ${deviceTokens.userId} = ${userId}::uuid then ${deviceTokens.createdAt} else ${now.toISOString()}::timestamptz end`,
    },
  }).returning({ id: deviceTokens.id });
  return row;
}

/** Removes this person's device (by token), or every device of this session when no token is given. */
export async function unregisterDevice(userId: string, opts: { token?: string; sessionId?: string | null }): Promise<number> {
  if (opts.token) {
    const r = await db.delete(deviceTokens).where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, opts.token.toLowerCase()))).returning({ id: deviceTokens.id });
    return r.length;
  }
  if (opts.sessionId) {
    const r = await db.delete(deviceTokens).where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.sessionId, opts.sessionId))).returning({ id: deviceTokens.id });
    return r.length;
  }
  return 0;
}

export type DeviceView = { id: string; platform: string; appVersion: string | null; locale: string | null; lastSeenAt: string; thisDevice: boolean };

/** A person's devices, without tokens. */
export async function listDevices(userId: string, sessionId: string | null): Promise<DeviceView[]> {
  const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId)).orderBy(sql`${deviceTokens.lastSeenAt} desc`);
  return rows.map((d) => ({
    id: d.id, platform: d.platform, appVersion: d.appVersion, locale: d.locale, lastSeenAt: d.lastSeenAt.toISOString(),
    thisDevice: !!sessionId && d.sessionId === sessionId,
  }));
}

export type DeviceRow = typeof deviceTokens.$inferSelect;

export async function devicesOf(userId: string): Promise<DeviceRow[]> {
  return db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId));
}

export async function deleteDeviceToken(token: string): Promise<void> {
  await db.delete(deviceTokens).where(eq(deviceTokens.token, token));
}

/* ── Settings ─────────────────────────────────────────────────────────────────────────────────────────── */

export type PushPrefs = {
  enabled: boolean;
  categories: Record<PushCategory, boolean>;
  quietStart: number | null;
  quietEnd: number | null;
};

const DEFAULT_PREFS: PushPrefs = {
  enabled: true,
  categories: { reminders: true, waiting: true, connections: true, clinical: true, test: true },
  quietStart: 22 * 60,
  quietEnd: 7 * 60,
};

function withDefaults(row: typeof pushSettings.$inferSelect | undefined): PushPrefs {
  if (!row) return { ...DEFAULT_PREFS, categories: { ...DEFAULT_PREFS.categories } };
  const categories = { ...DEFAULT_PREFS.categories };
  for (const c of PUSH_CATEGORIES) if (row.categories?.[c] === false) categories[c] = false;
  return { enabled: row.enabled, categories, quietStart: row.quietStart, quietEnd: row.quietEnd };
}

export async function getPrefs(userId: string): Promise<PushPrefs> {
  const [row] = await db.select().from(pushSettings).where(eq(pushSettings.userId, userId)).limit(1);
  return withDefaults(row);
}

export async function updatePrefs(userId: string, patch: Partial<Omit<PushPrefs, "categories">> & { categories?: Partial<Record<PushCategory, boolean>> }): Promise<PushPrefs> {
  const cur = await getPrefs(userId);
  const next: PushPrefs = {
    enabled: patch.enabled ?? cur.enabled,
    categories: { ...cur.categories, ...(patch.categories ?? {}) },
    quietStart: patch.quietStart !== undefined ? patch.quietStart : cur.quietStart,
    quietEnd: patch.quietEnd !== undefined ? patch.quietEnd : cur.quietEnd,
  };
  const categories: Record<string, boolean> = {};
  for (const c of PUSH_CATEGORIES) categories[c] = next.categories[c];
  await db.insert(pushSettings).values({ userId, enabled: next.enabled, categories, quietStart: next.quietStart, quietEnd: next.quietEnd, updatedAt: new Date() })
    .onConflictDoUpdate({ target: pushSettings.userId, set: { enabled: next.enabled, categories, quietStart: next.quietStart, quietEnd: next.quietEnd, updatedAt: new Date() } });
  return next;
}

/* ── Who, where, how many today ───────────────────────────────────────────────────────────────────────── */

export async function userTimeZone(userId: string): Promise<{ timeZone: string; locale: string } | null> {
  const [u] = await db.select({ timeZone: users.timeZone, locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
  return u ?? null;
}

/** The person's own cap on proactive nudges in this graph (assistant settings), default 5. */
export async function dailyCap(userId: string, graphId: string | null): Promise<number> {
  if (!graphId) return DEFAULT_DAILY_CAP;
  const [s] = await db.select({ cap: assistantSettings.dailySuggestionCap }).from(assistantSettings)
    .where(and(eq(assistantSettings.userId, userId), eq(assistantSettings.graphId, graphId))).limit(1);
  return s?.cap ?? DEFAULT_DAILY_CAP;
}

/** Capped pushes already sent in this graph on the person's local day. */
export async function sentToday(userId: string, graphId: string | null, timeZone: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 36 * 3600_000);
  const rows = await db.select({ createdAt: pushDeliveries.createdAt, graphId: pushDeliveries.graphId }).from(pushDeliveries)
    .where(and(eq(pushDeliveries.userId, userId), eq(pushDeliveries.counted, true), eq(pushDeliveries.status, "sent"), gte(pushDeliveries.createdAt, since)));
  const today = localDay(now, timeZone);
  return rows.filter((r) => (graphId ? r.graphId === graphId : true) && localDay(r.createdAt, timeZone) === today).length;
}

/** Claims a delivery key; false when it was already claimed (sent, or being sent by another instance). */
export async function claimDelivery(input: { userId: string; graphId: string | null; key: string; category: PushCategory; counted: boolean }): Promise<string | null> {
  const [row] = await db.insert(pushDeliveries).values({ ...input, status: "sending" })
    .onConflictDoNothing({ target: [pushDeliveries.userId, pushDeliveries.key] }).returning({ id: pushDeliveries.id });
  return row?.id ?? null;
}

export async function finishDelivery(id: string, status: "sent" | "failed" | "no_device", devices: number): Promise<void> {
  await db.update(pushDeliveries).set({ status, devices }).where(eq(pushDeliveries.id, id));
}

/** A failed attempt is let go, so the next tick may try again. */
export async function releaseDelivery(id: string): Promise<void> {
  await db.delete(pushDeliveries).where(eq(pushDeliveries.id, id));
}

/** Old delivery rows (kept 30 days for dedupe and the cap). */
export async function pruneDeliveries(): Promise<void> {
  await db.delete(pushDeliveries).where(sql`${pushDeliveries.createdAt} < now() - interval '30 days'`);
}
