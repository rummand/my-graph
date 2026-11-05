/**
 * A small read-only client for Holdsport's documented API (api.holdsport.dk/v1, HTTP basic auth with the member's
 * Holdsport login). Reads teams, members and activities; it never signs anyone up or off. Every request goes through
 * the connectors' SSRF-guarded transport and waits for the connection's rate limit first. The password is never logged.
 */
import type { Transport } from "@/lib/mcp-client/transport";
import { McpError } from "@/lib/mcp-client/errors";
import { allowPrivate } from "../../ssrf";

export const HOLDSPORT_API = "https://api.holdsport.dk/v1/";

export function holdsportBase(override: string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  const o = override?.trim();
  if (o && allowPrivate(env)) {
    try { const u = new URL(o); return `${u.protocol}//${u.host}${u.pathname.replace(/\/?$/, "/")}`; } catch { /* fall back */ }
  }
  return HOLDSPORT_API;
}

export type HoldsportErrorKind = "auth" | "rate" | "http" | "network" | "shape" | "privateHost";
export class HoldsportError extends Error {
  constructor(message: string, readonly kind: HoldsportErrorKind, readonly status?: number) {
    super(message);
    this.name = "HoldsportError";
  }
}

export const PER_PAGE = 100;

export class HoldsportApi {
  private auth: string;
  constructor(private o: { transport: Transport; user: string; password: string; base?: string; throttle?: () => Promise<void>; signal?: AbortSignal }) {
    this.auth = `Basic ${Buffer.from(`${o.user}:${o.password}`, "utf8").toString("base64")}`;
  }

  private async get(path: string, what: string, opts: { optional?: boolean } = {}): Promise<unknown> {
    await this.o.throttle?.();
    let res;
    try {
      res = await this.o.transport({
        url: new URL(path, this.o.base ?? HOLDSPORT_API).toString(), method: "GET",
        headers: { accept: "application/json", authorization: this.auth }, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, signal: this.o.signal,
      });
    } catch (e) {
      if (e instanceof McpError && e.code === "privateHost") throw new HoldsportError("Holdsport's address points to a private network.", "privateHost");
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new HoldsportError("Holdsport couldn't be reached.", "network");
    }
    if (res.status === 401 || res.status === 403) throw new HoldsportError("Holdsport didn't accept the user name or password.", "auth", res.status);
    if (opts.optional && (res.status === 404 || res.status === 405)) return null;
    if (res.status === 429) throw new HoldsportError("Holdsport asked us to slow down.", "rate", 429);
    if (res.status < 200 || res.status >= 300) throw new HoldsportError(`Holdsport had a problem reading ${what} (HTTP ${res.status}).`, "http", res.status);
    try {
      return JSON.parse(res.body.toString("utf8"));
    } catch {
      throw new HoldsportError(`Holdsport answered ${what} with something that isn't JSON.`, "shape");
    }
  }

  /** The login's own user, where Holdsport answers it (not every API version does). */
  me(): Promise<unknown> { return this.get("me", "your profile", { optional: true }); }

  async teams(): Promise<unknown[]> {
    const j = await this.get("teams", "your teams");
    return Array.isArray(j) ? j : [];
  }

  async members(teamId: string): Promise<unknown[]> {
    const j = await this.get(`teams/${encodeURIComponent(teamId)}/members`, "the team's members", { optional: true });
    return Array.isArray(j) ? j : [];
  }

  /** Activities from `from` (a day) on, page by page, until they pass `to` or `maxPages` is reached. */
  async activities(teamId: string, from: Date, to: Date, maxPages = 10): Promise<unknown[]> {
    const out: unknown[] = [];
    const day = from.toISOString().slice(0, 10);
    for (let page = 1; page <= maxPages; page++) {
      const j = await this.get(`teams/${encodeURIComponent(teamId)}/activities?date=${day}&page=${page}&per_page=${PER_PAGE}`, "the activities");
      const list = Array.isArray(j) ? j : [];
      let past = false;
      for (const a of list) {
        const start = Date.parse(String((a as { starttime?: unknown })?.starttime ?? ""));
        if (Number.isFinite(start) && start > to.getTime()) { past = true; continue; }
        out.push(a);
      }
      if (list.length < PER_PAGE || past) break;
    }
    return out;
  }
}
