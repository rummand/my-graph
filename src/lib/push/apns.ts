/**
 * The APNs sender (server-only): HTTP/2 to api.push.apple.com (or the sandbox), token-based auth with a JWT made by
 * ./pure. One HTTP/2 session per host is kept open and reused, as Apple asks; it is dropped on error or GOAWAY and
 * opened again on the next send. `ApnsTransport` is the seam the tests replace.
 */
import http2 from "node:http2";
import { APNS_HOSTS, JwtCache, classifyApnsResponse, type ApnsConfig, type ApnsEnv, type ApnsOutcome, type ApnsPayload } from "./pure";

export type ApnsRequest = {
  env: ApnsEnv;
  token: string;
  headers: Record<string, string>;
  body: string;
};
export type ApnsResponse = { status: number; reason?: string | null; apnsId?: string | null };
export type ApnsTransport = (req: ApnsRequest) => Promise<ApnsResponse>;

const sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();

function sessionFor(env: ApnsEnv): http2.ClientHttp2Session {
  const open = sessions.get(env);
  if (open && !open.closed && !open.destroyed) return open;
  const s = http2.connect(APNS_HOSTS[env]);
  const drop = () => { if (sessions.get(env) === s) sessions.delete(env); };
  s.on("error", (err) => { drop(); console.error("[push] APNs connection error:", err.message); });
  s.on("goaway", drop);
  s.on("close", drop);
  s.setTimeout(10 * 60_000, () => { drop(); s.close(); });
  s.unref();
  sessions.set(env, s);
  return s;
}

/** The real transport: one POST /3/device/<token> on the shared HTTP/2 session. */
export const http2Transport: ApnsTransport = (req) =>
  new Promise((resolve, reject) => {
    let s: http2.ClientHttp2Session;
    try { s = sessionFor(req.env); } catch (err) { reject(err); return; }
    const stream = s.request({ ":method": "POST", ":path": `/3/device/${req.token}`, ...req.headers });
    stream.setEncoding("utf8");
    let status = 0;
    let apnsId: string | null = null;
    let data = "";
    stream.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
      apnsId = (h["apns-id"] as string | undefined) ?? null;
    });
    stream.on("data", (chunk: string) => { data += chunk; });
    stream.on("end", () => {
      let reason: string | null = null;
      if (data) { try { reason = (JSON.parse(data) as { reason?: string }).reason ?? null; } catch { reason = null; } }
      resolve({ status, reason, apnsId });
    });
    stream.on("error", reject);
    stream.setTimeout(15_000, () => { stream.close(http2.constants.NGHTTP2_CANCEL); reject(new Error("APNs timed out")); });
    stream.end(req.body);
  });

export type SendOptions = {
  collapseId?: string;
  /** Seconds since epoch after which APNs drops it (0 = try once). Default: a day. */
  expiration?: number;
  env?: ApnsEnv | null;
};

export class ApnsSender {
  private readonly jwt: JwtCache;
  constructor(private readonly config: ApnsConfig, private readonly transport: ApnsTransport = http2Transport, now?: () => number) {
    this.jwt = new JwtCache(config, now);
  }

  get env(): ApnsEnv { return this.config.env; }

  /** Sends one alert to one device. Retries once with a fresh JWT when APNs says the provider token expired. */
  async send(token: string, payload: ApnsPayload, opts: SendOptions = {}): Promise<{ outcome: ApnsOutcome; status: number; reason?: string | null }> {
    const body = JSON.stringify(payload);
    const expiration = opts.expiration ?? Math.floor(Date.now() / 1000) + 24 * 3600;
    const env = opts.env ?? this.config.env;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {
        authorization: `bearer ${this.jwt.get()}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(expiration),
      };
      if (opts.collapseId) headers["apns-collapse-id"] = opts.collapseId;
      let res: ApnsResponse;
      try {
        res = await this.transport({ env, token, headers, body });
      } catch (err) {
        return { outcome: "retry", status: 0, reason: err instanceof Error ? err.message : "network" };
      }
      const outcome = classifyApnsResponse(res.status, res.reason);
      if (outcome === "auth" && attempt === 0) { this.jwt.invalidate(); continue; }
      return { outcome, status: res.status, reason: res.reason };
    }
    return { outcome: "auth", status: 403, reason: "InvalidProviderToken" };
  }
}

/** Closes the open HTTP/2 sessions (tests, shutdown). */
export function closeApnsSessions(): void {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}
