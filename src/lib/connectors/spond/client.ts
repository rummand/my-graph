/**
 * A small read-only client for Spond's unofficial API (api.spond.com/core/v1), as used by the open-source clients:
 * sign in with email and password for a bearer token, then read the profile, the groups and the events ("sponds").
 * It never answers an invitation, posts or changes anything. Every request goes through the connectors' SSRF-guarded
 * transport and waits for the connection's rate limit first. The password and token are never logged.
 */
import type { Transport } from "@/lib/mcp-client/transport";
import { McpError } from "@/lib/mcp-client/errors";
import { allowPrivate } from "../ssrf";

export const SPOND_API = "https://api.spond.com/core/v1/";

/** The API base: Spond, or a local mock where connectors may reach this computer (development). */
export function spondBase(override: string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  const o = override?.trim();
  if (o && allowPrivate(env)) {
    try { const u = new URL(o); return `${u.protocol}//${u.host}${u.pathname.replace(/\/?$/, "/")}`; } catch { /* fall back */ }
  }
  return SPOND_API;
}

export type SpondErrorKind = "auth" | "rate" | "http" | "network" | "shape" | "privateHost";
export class SpondError extends Error {
  constructor(message: string, readonly kind: SpondErrorKind, readonly status?: number) {
    super(message);
    this.name = "SpondError";
  }
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");

export class SpondApi {
  private token: string | null = null;
  constructor(private o: { transport: Transport; base?: string; throttle?: () => Promise<void>; signal?: AbortSignal }) {}

  private get base() { return this.o.base ?? SPOND_API; }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    await this.o.throttle?.();
    let res;
    try {
      res = await this.o.transport({
        url: new URL(path, this.base).toString(), method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, signal: this.o.signal,
      });
    } catch (e) {
      if (e instanceof McpError && e.code === "privateHost") throw new SpondError("Spond's address points to a private network.", "privateHost");
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new SpondError("Spond couldn't be reached.", "network");
    }
    let json: unknown = null;
    const text = res.body.toString("utf8");
    if (text.trim()) { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: res.status, json };
  }

  private check(r: { status: number; json: unknown }, what: string): unknown {
    if (r.status === 401 || r.status === 403) throw new SpondError("Spond ended the sign-in.", "auth", r.status);
    if (r.status === 429) throw new SpondError("Spond asked us to slow down.", "rate", 429);
    if (r.status < 200 || r.status >= 300) throw new SpondError(`Spond had a problem reading ${what} (HTTP ${r.status}).`, "http", r.status);
    if (r.json == null) throw new SpondError(`Spond answered ${what} with something that isn't JSON.`, "shape");
    return r.json;
  }

  /** Sign in. The newer endpoint (auth2/login → accessToken.token) first, the older one (login → loginToken) after. */
  async login(email: string, password: string): Promise<void> {
    const body = { email, password };
    let r = await this.call("POST", "auth2/login", body);
    if (r.status === 404 || r.status === 405) r = await this.call("POST", "login", body);
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new SpondError("Spond didn't accept the email or password.", "auth", r.status);
    const j = this.check(r, "the sign-in") as Record<string, unknown>;
    const access = j.accessToken;
    const token = typeof access === "string" ? access
      : access && typeof access === "object" && typeof (access as { token?: unknown }).token === "string" ? (access as { token: string }).token
      : typeof j.loginToken === "string" ? j.loginToken : null;
    if (!token) throw new SpondError("Spond didn't hand out a sign-in token.", "auth");
    this.token = token;
  }

  async profile(): Promise<unknown> { return this.check(await this.call("GET", "profile"), "your profile"); }

  async groups(): Promise<unknown[]> {
    const j = this.check(await this.call("GET", "groups/"), "your groups");
    return Array.isArray(j) ? j : [];
  }

  /** Events that end after `from` and start before `to`, oldest first, in pages (at most `maxPages` × 200). */
  async events(from: Date, to: Date, maxPages = 5): Promise<unknown[]> {
    const out: unknown[] = [];
    const seen = new Set<string>();
    let minStart: Date | null = null;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({
        addProfileInfo: "true", scheduled: "false", includeHidden: "false", includeComments: "false", order: "asc", max: "200",
        minEndTimestamp: iso(from), maxStartTimestamp: iso(to), ...(minStart ? { minStartTimestamp: iso(minStart) } : {}),
      });
      const j = this.check(await this.call("GET", `sponds/?${q}`), "the events");
      const list = Array.isArray(j) ? j : [];
      let fresh = 0;
      let last: Date | null = null;
      for (const e of list) {
        const id = (e as { id?: unknown })?.id;
        const start = (e as { startTimestamp?: unknown })?.startTimestamp;
        if (typeof start === "string" && !Number.isNaN(Date.parse(start))) last = new Date(start);
        if (typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);
        out.push(e);
        fresh++;
      }
      if (list.length < 200 || !fresh || !last) break;
      minStart = last;
    }
    return out;
  }
}
