/**
 * A read-only Aula API client (server-only, no DB). Ported in spirit from aula-mcp's AulaClient
 * (github.com/Casperjuel/aula-mcp, packages/aula-client/src/aula-client.ts, MIT, Copyright (c) 2026 Casper Juel;
 * licence in LICENSE-aula-mcp.txt) with the endpoints checked against nickknissen/aula (Python, MIT).
 *
 *   - Every request goes through the connectors' SSRF-guarded transport (localhost only in development).
 *   - The access token travels as the `access_token` query parameter (Aula's quirk; it doesn't take Bearer headers).
 *   - API version: Aula serves /api/v{N}/ and answers 410 on a retired N. The first call probes from the saved version
 *     upwards with profiles.getProfilesByLogin (200 = this one, 410 = try the next); a 410 later in the run probes
 *     again from N+1 and repeats the request once.
 *   - POST reads (the calendar) need profiles.getProfileContext first and the Csrfp-Token cookie as a header.
 *   - Envelope errors: status.code ≠ 0 is an error; sub-codes 9/13 = the sign-in ended, 8 = MitID step-up (sensitive),
 *     7 = deactivated user.
 *
 * READ ONLY, by construction: only methods in READ_METHODS can be called. Nothing here can send a message, report
 * sickness, change presence or move a thread's read marker. In particular `messaging.setLastReadMessage` is not in
 * the list: Aula keeps one read marker per thread that only that POST moves (aula-mcp's setLastReadMessage, and
 * nickknissen/aula's mark_thread_read which reads the thread, then posts setLastReadMessage, then re-reads the thread
 * to confirm the marker moved). Reading a thread with getMessagesForThread does not move the marker, so reading here
 * never marks anything as read in Aula.
 */
import type { Transport } from "@/lib/mcp-client/transport";
import { API_VERSION_MAX, API_VERSION_START, SUBCODE } from "./constants";

export const READ_METHODS = new Set([
  "profiles.getProfilesByLogin",
  "profiles.getProfileContext",
  "messaging.getThreads",
  "messaging.getMessagesForThread",
  "posts.getAllPosts",
  "calendar.getEventsByProfileIdsAndResourceIds",
  "presence.getDailyOverview",
  "gallery.getAlbums",
  "gallery.getMedia",
]);

/** The few POST methods that only read (Aula takes the calendar query as a JSON body). */
const POST_READS = new Set(["calendar.getEventsByProfileIdsAndResourceIds"]);

export type AulaErrorKind = "auth" | "stepUp" | "deactivated" | "version" | "http" | "envelope" | "refused" | "network";

export class AulaError extends Error {
  constructor(message: string, readonly kind: AulaErrorKind, readonly status?: number, readonly code?: number) {
    super(message);
    this.name = "AulaError";
  }
}

type Envelope<T> = { status?: { code?: number; subCode?: number; message?: string }; data?: T };

export type AulaApiOptions = {
  transport: Transport;
  apiBase: string;
  /** The current access token (read on every request, so a refresh mid-run is picked up). */
  accessToken: () => string;
  /** The version that worked last time (saved on the connection). */
  version?: number | null;
  maxVersion?: number;
  onVersionChanged?: (from: number, to: number) => void;
  /** Called before every request (the connector's rate limit). */
  throttle?: () => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type Param = [string, string | number];

/** Cookie names and values from Set-Cookie headers (the transport joins several with ", "). Attributes are skipped. */
export function cookiesFrom(setCookie: string | undefined): [string, string][] {
  if (!setCookie) return [];
  const out: [string, string][] = [];
  const skip = new Set(["path", "domain", "expires", "max-age", "samesite", "secure", "httponly", "priority", "partitioned"]);
  for (const m of setCookie.matchAll(/(?:^|,)\s*([A-Za-z0-9_.!#$%&'*+^`|~-]+)=([^;,]*)/g)) {
    if (!skip.has(m[1].toLowerCase())) out.push([m[1], m[2].trim()]);
  }
  return out;
}

export class AulaApi {
  private version: number;
  private verified = false;
  private probing: Promise<number> | null = null;
  private contextReady: Promise<void> | null = null;
  private readonly jar = new Map<string, string>();
  readonly calls: string[] = [];

  constructor(private readonly o: AulaApiOptions) {
    this.version = o.version && o.version > 0 ? o.version : API_VERSION_START;
  }

  get apiVersion(): number {
    return this.version;
  }

  private url(version: number, params: Param[]): string {
    const q = new URLSearchParams();
    for (const [k, v] of params) q.append(k, String(v));
    q.set("access_token", this.o.accessToken());
    return `${this.o.apiBase.replace(/\/$/, "")}/api/v${version}/?${q.toString()}`;
  }

  private async send(method: "GET" | "POST", version: number, params: Param[], body?: string) {
    await this.o.throttle?.();
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method === "POST") {
      headers["content-type"] = "application/json";
      const csrf = this.jar.get("Csrfp-Token");
      if (csrf) headers["csrfp-token"] = csrf;
    }
    let res;
    try {
      res = await this.o.transport({ url: this.url(version, params), method, headers, body, signal: this.o.signal, timeoutMs: this.o.timeoutMs ?? 30_000, maxBytes: 16 * 1024 * 1024 });
    } catch (e) {
      // The transport's own messages never contain the URL (and so never the token).
      throw new AulaError(e instanceof Error ? e.message : "Aula couldn't be reached.", "network");
    }
    for (const [k, v] of cookiesFrom(res.headers["set-cookie"])) this.jar.set(k, v);
    return { status: res.status, text: res.body.toString("utf8") };
  }

  /** Find the API version that answers (200), walking up past retired ones (410). */
  async ensureVersion(): Promise<number> {
    if (this.verified) return this.version;
    this.probing ??= this.probe().finally(() => { this.probing = null; });
    return this.probing;
  }

  private async probe(): Promise<number> {
    const max = this.o.maxVersion ?? API_VERSION_MAX;
    const start = this.version;
    for (let v = start; v <= max; v++) {
      this.calls.push(`probe:v${v}`);
      const r = await this.send("GET", v, [["method", "profiles.getProfilesByLogin"]]);
      if (r.status === 410) continue;
      if (r.status === 401) throw new AulaError("Aula ended the sign-in.", "auth", 401);
      if (r.status !== 200) throw new AulaError(`Aula answered HTTP ${r.status} while finding its API version.`, "version", r.status);
      this.checkEnvelope(parseEnvelope(r.text), "profiles.getProfilesByLogin");
      if (v !== this.version) {
        const from = this.version;
        this.version = v;
        this.o.onVersionChanged?.(from, v);
      }
      this.verified = true;
      return v;
    }
    throw new AulaError(`No working Aula API version between v${start} and v${max}.`, "version", 410);
  }

  private checkEnvelope<T>(env: Envelope<T>, method: string): void {
    const sub = env.status?.subCode;
    const code = env.status?.code ?? 0;
    if (sub === SUBCODE.invalidToken || sub === SUBCODE.sessionExpired) throw new AulaError("Aula ended the sign-in.", "auth", 401, sub);
    if (sub === SUBCODE.stepUp || (code === 403 && method === "messaging.getMessagesForThread")) throw new AulaError("This needs a fresh MitID approval in Aula (sensitive).", "stepUp", 403, sub ?? code);
    if (sub === SUBCODE.deactivated) throw new AulaError("Aula says this user is deactivated.", "deactivated", 403, sub);
    if (code !== 0) throw new AulaError(`Aula refused ${method} (code ${code}${env.status?.message ? `: ${env.status.message.slice(0, 120)}` : ""}).`, "envelope", 200, code);
  }

  /** Call one read method. Anything not in READ_METHODS is refused before a byte is sent. */
  async call<T>(method: string, params: Param[] = [], body?: unknown): Promise<T | undefined> {
    if (!READ_METHODS.has(method)) throw new AulaError(`"${method}" is not a read and is never called.`, "refused");
    const post = POST_READS.has(method);
    if (post && !this.contextReady) {
      // Aula refuses every POST until the acting profile is chosen for the session (aula-mcp postJson).
      this.contextReady = this.call("profiles.getProfileContext", [["portalrole", "guardian"]]).then(() => undefined, () => { this.contextReady = null; });
    }
    if (post) await this.contextReady;
    let version = await this.ensureVersion();
    const all: Param[] = [["method", method], ...params];
    this.calls.push(method);
    let r = await this.send(post ? "POST" : "GET", version, all, body === undefined ? undefined : JSON.stringify(body));
    if (r.status === 410) {
      // Aula moved to a new version while we were reading: find it and send the same request once more.
      this.verified = false;
      this.version = version + 1;
      version = await this.ensureVersion();
      r = await this.send(post ? "POST" : "GET", version, all, body === undefined ? undefined : JSON.stringify(body));
    }
    if (r.status === 401) throw new AulaError("Aula ended the sign-in.", "auth", 401);
    if (r.status === 429) throw new AulaError("Aula asked us to slow down.", "http", 429);
    if (r.status !== 200) {
      // A step-up answer can also arrive as an HTTP 403 with the envelope inside.
      if (r.status === 403) this.checkEnvelope(parseEnvelope(r.text), method);
      throw new AulaError(`Aula answered HTTP ${r.status} to ${method}.`, "http", r.status);
    }
    const env = parseEnvelope<T>(r.text);
    this.checkEnvelope(env, method);
    return env.data;
  }

  /* ── The reads ────────────────────────────────────────────────────────────────────────────────────── */

  profilesByLogin() { return this.call<unknown>("profiles.getProfilesByLogin"); }
  profileContext() { return this.call<unknown>("profiles.getProfileContext", [["portalrole", "guardian"]]); }

  /** One page of threads, newest activity first. Aula serves 20 per page whatever pageSize says. */
  threadsPage(page: number) {
    return this.call<{ threads?: unknown[]; moreMessagesExist?: boolean }>("messaging.getThreads", [["sortOn", "date"], ["orderDirection", "desc"], ["page", page]]);
  }

  /** One page of a thread's messages (newest first). Reading does not move the thread's read marker. */
  messagesPage(threadId: string | number, page: number) {
    return this.call<{ messages?: unknown[]; subject?: string; moreMessagesExist?: boolean }>("messaging.getMessagesForThread", [["threadId", threadId], ["page", page]]);
  }

  posts(index: number, limit: number, institutionProfileIds: number[]) {
    const p: Param[] = [["parent", "profile"], ["index", index], ["limit", limit], ["isUnread", "false"]];
    for (const id of institutionProfileIds) p.push(["institutionProfileIds[]", id]);
    return this.call<{ posts?: unknown[]; moreMessagesExist?: boolean }>("posts.getAllPosts", p);
  }

  calendar(institutionProfileIds: number[], start: string, end: string) {
    return this.call<unknown[]>("calendar.getEventsByProfileIdsAndResourceIds", [], { instProfileIds: institutionProfileIds, resourceIds: [], start, end });
  }

  dailyOverview(childIds: number[]) {
    const p: Param[] = childIds.map((id) => ["childIds[]", id]);
    return this.call<unknown[]>("presence.getDailyOverview", p);
  }

  albums(institutionProfileIds: number[], limit: number) {
    const p: Param[] = [["index", 0], ["limit", limit], ["sortOn", "createdAt"], ["orderDirection", "desc"], ["filterBy", "all"]];
    for (const id of institutionProfileIds) p.push(["filterInstProfileIds[]", id]);
    return this.call<unknown>("gallery.getAlbums", p);
  }

  media(albumId: string | number, institutionProfileIds: number[], limit: number) {
    const p: Param[] = [["albumId", albumId], ["index", 0], ["limit", limit], ["sortOn", "uploadedAt"], ["orderDirection", "desc"], ["filterBy", "all"]];
    for (const id of institutionProfileIds) p.push(["filterInstProfileIds[]", id]);
    return this.call<unknown>("gallery.getMedia", p);
  }
}

function parseEnvelope<T>(text: string): Envelope<T> {
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === "object" ? (j as Envelope<T>) : {};
  } catch {
    throw new AulaError("Aula's answer wasn't JSON.", "envelope");
  }
}
