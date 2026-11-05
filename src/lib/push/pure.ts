/**
 * Push rules with no I/O, so they are tested without a database or APNs: the APNs token (JWT, ES256), what a
 * notification says (sensitive items never carry their text), quiet hours, the daily cap and which APNs answers mean
 * the device token is gone.
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { DICTIONARIES } from "@/lib/i18n/messages";
import { isLocale, makeT, type Locale } from "@/lib/i18n/core";

/* ── Config ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type ApnsEnv = "sandbox" | "production";

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  /** The .p8 file's contents (PEM). Never logged or returned. */
  key: string;
  bundleId: string;
  env: ApnsEnv;
};

export const APNS_HOSTS: Record<ApnsEnv, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/**
 * Reads APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY, APNS_BUNDLE_ID and APNS_ENV. Returns the names that are missing instead
 * of a config when push can't run (never the values). APNS_KEY may hold the PEM with real or "\n"-escaped newlines,
 * or the PEM base64-encoded on one line (easier to paste into Railway).
 */
export function readApnsConfig(env: Record<string, string | undefined>): { config: ApnsConfig } | { missing: string[] } {
  const missing = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY", "APNS_BUNDLE_ID"].filter((k) => !env[k]?.trim());
  if (missing.length) return { missing };
  const e = (env.APNS_ENV ?? "production").trim().toLowerCase();
  const apnsEnv: ApnsEnv = e === "sandbox" || e === "development" ? "sandbox" : "production";
  return {
    config: {
      keyId: env.APNS_KEY_ID!.trim(),
      teamId: env.APNS_TEAM_ID!.trim(),
      key: normalizeP8(env.APNS_KEY!),
      bundleId: env.APNS_BUNDLE_ID!.trim(),
      env: apnsEnv,
    },
  };
}

export function normalizeP8(raw: string): string {
  let s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(s, "base64").toString("utf8");
      if (decoded.includes("-----BEGIN")) s = decoded.trim();
    } catch { /* not base64: leave it */ }
  }
  return s.replace(/\\n/g, "\n").trim();
}

/* ── JWT (ES256) for token-based APNs auth ──────────────────────────────────────────────────────────────── */

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * The provider token APNs wants in `authorization: bearer …`: header { alg: ES256, kid }, claims { iss: team, iat }.
 * Signed with the .p8 key; `dsaEncoding: "ieee-p1363"` gives the raw r||s signature JWS needs (not DER).
 */
export function buildApnsJwt(input: { keyId: string; teamId: string; key: string | KeyObject; issuedAt: number }): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const claims = b64url(JSON.stringify({ iss: input.teamId, iat: Math.floor(input.issuedAt) }));
  const signingInput = `${header}.${claims}`;
  const key = typeof input.key === "string" ? createPrivateKey(input.key) : input.key;
  const sig = createSign("SHA256").update(signingInput).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

/** APNs refuses tokens older than an hour and throttles new ones made more often than every 20 minutes. */
export const JWT_REFRESH_SECONDS = 50 * 60;

/** Keeps one token and makes a new one when it is 50 minutes old (or when APNs said it expired). */
export class JwtCache {
  private token: string | null = null;
  private issuedAt = 0;
  constructor(private readonly config: Pick<ApnsConfig, "keyId" | "teamId" | "key">, private readonly now: () => number = () => Date.now() / 1000) {}

  get(): string {
    const t = this.now();
    if (!this.token || t - this.issuedAt >= JWT_REFRESH_SECONDS) {
      this.issuedAt = Math.floor(t);
      this.token = buildApnsJwt({ ...this.config, issuedAt: this.issuedAt });
    }
    return this.token;
  }

  invalidate(): void { this.token = null; }
}

/* ── APNs answers ───────────────────────────────────────────────────────────────────────────────────────── */

export type ApnsOutcome = "sent" | "invalid_token" | "auth" | "retry" | "failed";

/** What an APNs answer means for the device token. 410 and bad-token reasons mean the token should be deleted. */
export function classifyApnsResponse(status: number, reason?: string | null): ApnsOutcome {
  if (status === 200) return "sent";
  if (status === 410) return "invalid_token";
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return "invalid_token";
  if (status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) return "auth";
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}

/* ── What a notification says ───────────────────────────────────────────────────────────────────────────── */

export type PushCategory = "reminders" | "waiting" | "connections" | "clinical" | "test";
export const PUSH_CATEGORIES: Exclude<PushCategory, "test">[] = ["reminders", "waiting", "connections", "clinical"];

/** Kinds that count toward the daily cap. A reminder the person set, and a risk flag for the clinician, always go. */
export const CAPPED: Record<PushCategory, boolean> = { reminders: false, waiting: true, connections: true, clinical: false, test: false };

export type PushItem =
  | { kind: "reminder"; id: string; graphId: string; title: string; sensitive: boolean; aboutNodeId?: string | null }
  | { kind: "waiting"; graphId: string; graphName?: string | null; count: number; multipleGraphs?: boolean; changeSetId?: string | null; onlyChangeSets: boolean }
  | { kind: "connection"; id: string; graphId: string; label: string }
  | { kind: "clinical"; id: string; graphId: string }
  | { kind: "test" };

export function categoryOf(item: PushItem): PushCategory {
  switch (item.kind) {
    case "reminder": return "reminders";
    case "waiting": return "waiting";
    case "connection": return "connections";
    case "clinical": return "clinical";
    case "test": return "test";
  }
}

/** The APNs JSON body. `mg` carries only ids and a path to open: no titles, names or quotes. */
export type ApnsPayload = {
  aps: { alert: { title: string; body: string }; sound: "default"; "thread-id": string };
  mg: { kind: PushItem["kind"]; href: string; graphId?: string; id?: string };
};

const SAFE_LABEL = /^[\p{L}\p{N} .,'’()&+\-/@]{1,40}$/u;

export function buildPayload(item: PushItem, locale: string | null | undefined): ApnsPayload {
  const l: Locale = isLocale(locale) ? locale : "en";
  const t = makeT(l, DICTIONARIES[l], DICTIONARIES.en);
  const base = (title: string, body: string, thread: string, mg: ApnsPayload["mg"]): ApnsPayload => ({
    aps: { alert: { title, body }, sound: "default", "thread-id": thread },
    mg,
  });
  switch (item.kind) {
    case "reminder": {
      const href = item.aboutNodeId && !item.sensitive ? `/people/${item.aboutNodeId}` : "/";
      if (item.sensitive) return base(t("push.reminder.title"), t("push.reminder.private"), "reminders", { kind: "reminder", href, graphId: item.graphId, id: item.id });
      const title = clip(item.title, 120) || t("push.reminder.title");
      return base(title, t("push.reminder.due"), "reminders", { kind: "reminder", href, graphId: item.graphId, id: item.id });
    }
    case "waiting": {
      const href = item.onlyChangeSets ? (item.count === 1 && item.changeSetId ? `/changes/${item.changeSetId}` : "/changes") : "/";
      const graph = item.graphName && SAFE_LABEL.test(item.graphName) ? item.graphName : null;
      const body = graph && item.multipleGraphs ? t("push.waiting.inGraph", { count: item.count, graph }) : t("push.waiting.body", { count: item.count });
      return base(t("push.waiting.title"), body, "waiting", { kind: "waiting", href, graphId: item.graphId });
    }
    case "connection": {
      const label = SAFE_LABEL.test(item.label) ? item.label : t("push.connection.title");
      return base(t("push.connection.title"), t("push.connection.body", { label }), "connections", { kind: "connection", href: "/connections", graphId: item.graphId, id: item.id });
    }
    case "clinical":
      // Never the client, the category or the quote: only that there is something to look at.
      return base(t("push.clinical.title"), t("push.clinical.body"), "clinical", { kind: "clinical", href: "/clinical", graphId: item.graphId, id: item.id });
    case "test":
      return base(t("push.test.title"), t("push.test.body"), "test", { kind: "test", href: "/" });
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").replace(/@\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** apns-collapse-id: a newer notification about the same thing replaces the older one on the lock screen. */
export function collapseIdFor(item: PushItem): string {
  switch (item.kind) {
    case "reminder": return `r-${item.id}`.slice(0, 64);
    case "waiting": return `w-${item.graphId}`.slice(0, 64);
    case "connection": return `c-${item.id}`.slice(0, 64);
    case "clinical": return `k-${item.id}`.slice(0, 64);
    case "test": return "test";
  }
}

/* ── Quiet hours and the daily cap ──────────────────────────────────────────────────────────────────────── */

/** Minutes after local midnight in `timeZone` (falls back to UTC on an unknown zone). */
export function localMinutes(now: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return (h % 24) * 60 + m;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** The local calendar day ("2026-11-04") in `timeZone`. */
export function localDay(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Quiet hours are [start, end) in local minutes; start > end wraps midnight (22:00–07:00). Equal or null = none. */
export function inQuietHours(now: Date, timeZone: string, start: number | null | undefined, end: number | null | undefined): boolean {
  if (start == null || end == null || start === end) return false;
  const m = localMinutes(now, timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export const DEFAULT_DAILY_CAP = 5;

export type Gate =
  | { send: true; counted: boolean }
  | { send: false; reason: "disabled" | "category_off" | "quiet_hours" | "cap" };

/**
 * Whether to send one item now. Quiet hours hold it back (it goes once they end, while still relevant); the cap
 * drops capped kinds for the rest of the local day. `sentToday` counts capped pushes already sent today.
 */
export function gate(input: {
  category: PushCategory;
  enabled: boolean;
  categories: Record<string, boolean>;
  quiet: boolean;
  sentToday: number;
  cap: number;
}): Gate {
  if (input.category === "test") return { send: true, counted: false };
  if (!input.enabled) return { send: false, reason: "disabled" };
  if (input.categories[input.category] === false) return { send: false, reason: "category_off" };
  if (input.quiet) return { send: false, reason: "quiet_hours" };
  const counted = CAPPED[input.category];
  if (counted && input.sentToday >= Math.max(0, input.cap)) return { send: false, reason: "cap" };
  return { send: true, counted };
}

/** Parse "HH:MM" to minutes after midnight; null for empty. */
export function parseClock(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatClock(min: number | null | undefined): string | null {
  if (min == null) return null;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** APNs device tokens are 64 hex characters today; accept 32–200 hex to be safe with future lengths. */
export function isDeviceToken(s: string): boolean {
  return /^[0-9a-f]{32,200}$/i.test(s);
}

/** Only the end of a token, for logs. */
export function tokenTail(token: string): string {
  return `…${token.slice(-6)}`;
}
