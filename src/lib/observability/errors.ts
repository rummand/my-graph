/**
 * Server error grouping and redaction (pure). An error becomes an event that holds metadata only: its kind and name,
 * a redacted message, code locations from the stack, the route pattern, and a salted hash of the account. Events with
 * the same fingerprint are one group on the Admin "Errors" page.
 *
 * Redaction is deliberately blunt: quoted text, e-mail addresses, URLs, ids, tokens, long numbers and anything that
 * looks like a credential are replaced, so a message can't carry what a person wrote or a secret.
 */
import { createHash } from "node:crypto";
import { normalizeMethod, normalizeRoute } from "./collector";

export type ErrorKind = "error" | "status" | "slow";
export type ErrorSource = "render" | "route" | "action" | "middleware" | "request";

export type ErrorInput = {
  kind: ErrorKind;
  name?: string | null;
  message?: string | null;
  stack?: string | null;
  route?: string | null;
  method?: string | null;
  source?: ErrorSource | null;
  status?: number | null;
  digest?: string | null;
  userId?: string | null;
  durationMs?: number | null;
  at?: Date;
};

export type ErrorEvent = {
  fingerprint: string;
  kind: ErrorKind;
  name: string;
  message: string;
  stackHash: string;
  frames: string[];
  route: string;
  method: string;
  source: ErrorSource;
  status: number | null;
  digest: string | null;
  userHash: string | null;
  durationMs: number | null;
  at: Date;
};

const MAX_MESSAGE = 300;
const MAX_FRAMES = 8;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Replace anything personal or secret in an error message; keeps the shape ("Cannot read … of undefined"). */
export function redactMessage(input: string | null | undefined): string {
  let s = String(input ?? "").slice(0, 4000);
  s = s
    // Credentials first, while their key names are still there to recognise them.
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|session|client[_-]?secret|signature)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/gi, "$1$2<redacted>")
    .replace(/\b(sk|pk|rk|whsec|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "<token>")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "<token>")
    // Places and people.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "<url>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    // Postgres "Key (email)=(anna@example.com) already exists": keep the column, drop the value.
    .replace(/\)=\([^)]*\)/g, ")=(<value>)")
    // Quoted text of any kind is content until proven otherwise.
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»|`[^`\n]*`/g, "\"…\"")
    // Identifiers and numbers.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "<token>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<token>")
    .replace(/\b\d{6}-?\d{4}\b/g, "<n>") // Danish CPR shape
    .replace(/\+?\d[\d ()-]{6,}\d/g, "<n>") // phone numbers and other long digit runs
    .replace(/\b\d{5,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s;
}

/** A name for the error class, from a short safe alphabet ("TypeError", "PostgresError"). */
export function safeName(name: string | null | undefined): string {
  const n = String(name ?? "").replace(/[^A-Za-z0-9_.$]/g, "").slice(0, 60);
  return n || "Error";
}

/**
 * Code locations from a stack: "fn (src/lib/x.ts:12:5)". Paths are cut to the project (src/…) or the package
 * (node_modules/pkg/…), bundler prefixes go, and only frame lines are read, so the message line (which may hold
 * content) never comes through here.
 */
export function stackFrames(stack: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(stack ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const m = /^at (?:(.+?) \()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/.exec(line);
    if (!m) continue;
    const fn = (m[1] ?? "").replace(/[^\w$.<>[\] -]/g, "").slice(0, 80) || "<anonymous>";
    const file = cleanPath(m[2]);
    if (!file) continue;
    out.push(`${fn} (${file}${m[3] ? `:${m[3]}` : ""}${m[4] ? `:${m[4]}` : ""})`);
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

function cleanPath(p: string): string {
  let f = p.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, "").replace(/^file:\/\//, "").replace(/^\.\//, "");
  if (f.startsWith("node:")) return f.slice(0, 80);
  const src = f.lastIndexOf("/src/");
  const nm = f.lastIndexOf("node_modules/");
  if (nm >= 0) f = f.slice(nm);
  else if (src >= 0) f = f.slice(src + 1);
  else if (f.includes("/.next/")) f = f.slice(f.indexOf("/.next/") + 1);
  else if (f.startsWith("/")) f = f.split("/").slice(-2).join("/"); // never a home directory or username
  return f.replace(/[?#].*$/, "").slice(0, 160);
}

/** The frames that identify an error: app frames first (src/…), without line numbers (they move between builds). */
export function framesKey(frames: string[]): string {
  const app = frames.filter((f) => f.includes("(src/"));
  return (app.length ? app : frames).slice(0, 5).map((f) => f.replace(/:\d+(?::\d+)?\)$/, ")")).join("|");
}

/** The message shape for grouping: digits fold away so "after 31 ms" and "after 32 ms" are one group. */
export function messageKey(redacted: string): string {
  return redacted.replace(/\d+/g, "#").toLowerCase();
}

/** A salted hash for counting distinct accounts; never reversible to the id without the salt. */
export function hashUser(userId: string | null | undefined, salt: string): string | null {
  if (!userId) return null;
  return createHash("sha256").update(`mg-obs|${salt}|${userId}`).digest("base64url").slice(0, 16);
}

export function fingerprintOf(e: Pick<ErrorEvent, "kind" | "name" | "message" | "frames" | "route" | "method" | "status">): string {
  const parts = e.kind === "slow" ? ["slow", e.route, e.method]
    : e.kind === "status" ? ["status", e.route, e.method, String(e.status ?? "")]
    : ["error", e.name, messageKey(e.message), framesKey(e.frames), e.route];
  return sha(parts.join("\u0000")).slice(0, 32);
}

export function toErrorEvent(input: ErrorInput, salt: string): ErrorEvent {
  const frames = stackFrames(input.stack);
  const kind = input.kind;
  const name = kind === "slow" ? "SlowRequest" : kind === "status" ? "ServerErrorResponse" : safeName(input.name);
  const message = kind === "error" ? redactMessage(input.message) || "(no message)" : "";
  const route = normalizeRoute(input.route);
  const method = input.method ? normalizeMethod(input.method) : "";
  const status = typeof input.status === "number" && Number.isFinite(input.status) ? Math.trunc(input.status) : null;
  const base = { kind, name, message, frames, route, method, status };
  return {
    ...base,
    fingerprint: fingerprintOf(base),
    stackHash: sha(framesKey(frames)).slice(0, 16),
    source: input.source ?? "request",
    digest: input.digest ? String(input.digest).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || null : null,
    userHash: hashUser(input.userId, salt),
    durationMs: typeof input.durationMs === "number" && Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : null,
    at: input.at ?? new Date(),
  };
}

/** Errors that are Next.js control flow (redirect, notFound, bailouts) or a deliberate 4xx Response, not faults. */
export function isExpected(err: unknown): boolean {
  if (typeof Response !== "undefined" && err instanceof Response) return err.status < 500;
  if (!err || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest === "string" && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING|NEXT_PRERENDER_INTERRUPTED|HANGING_PROMISE_REJECTION)/.test(digest)) return true;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}

/** Several events of one group since the last flush, folded into one upsert. */
export type ErrorAgg = { event: ErrorEvent; count: number; userHashes: Set<string>; maxDurationMs: number | null };

export function foldEvent(map: Map<string, ErrorAgg>, e: ErrorEvent, maxGroups = 500): void {
  const cur = map.get(e.fingerprint);
  if (cur) {
    cur.count += 1;
    cur.event = e; // the latest message, frames and time
    if (e.userHash && cur.userHashes.size < 50) cur.userHashes.add(e.userHash);
    if (e.durationMs != null) cur.maxDurationMs = Math.max(cur.maxDurationMs ?? 0, e.durationMs);
    return;
  }
  if (map.size >= maxGroups) return; // a storm of distinct errors: keep the first ones, drop the rest until the flush
  map.set(e.fingerprint, { event: e, count: 1, userHashes: new Set(e.userHash ? [e.userHash] : []), maxDurationMs: e.durationMs });
}
