/**
 * Test doubles for the provider connectors (pure, no DB, no network): a run context that keeps cursors in memory, a
 * sink that records what would be stored, and a fake API that answers from a small route function.
 */
import { CursorExpired } from "../errors";
import { resetStream, withCursor, type ConnectionState } from "../state";
import type { RunContext, StreamCounts } from "../types";
import type { Api, ApiRequest, ApiResponse } from "./client";
import type { SyncDeps } from "./deps";
import { apiBase } from "./providers";
import type { EventItem, FileItem, MailItem, Sink } from "./sink";

export type Answer = { status?: number; json?: unknown; body?: string | Buffer; headers?: Record<string, string> };

export function fakeApi(handler: (req: ApiRequest & { u: URL }) => Answer | undefined): Api & { calls: ApiRequest[] } {
  const calls: ApiRequest[] = [];
  const fn = (async (req: ApiRequest): Promise<ApiResponse> => {
    calls.push(req);
    const a = handler({ ...req, u: new URL(req.url) }) ?? { status: 404, json: { error: "no route" } };
    const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body ?? (a.json !== undefined ? JSON.stringify(a.json) : ""));
    const status = a.status ?? 200;
    return {
      status, headers: a.headers ?? {}, body, url: req.url,
      json<T>() { try { return JSON.parse(body.toString("utf8")) as T; } catch { return null; } },
    };
  }) as Api & { calls: ApiRequest[] };
  fn.calls = calls;
  return fn;
}

export type Recorded = {
  mail: MailItem[]; files: FileItem[]; events: EventItem[]; removed: string[];
  versions: Map<string, string>; knownMail: Set<string>;
};

export function memorySink(): Sink & { rec: Recorded } {
  const rec: Recorded = { mail: [], files: [], events: [], removed: [], versions: new Map(), knownMail: new Set() };
  return {
    rec,
    async knownMail(_ctx, ids) { return new Set(ids.filter((i) => rec.knownMail.has(i))); },
    async mail(ctx, stream, items, cursor) {
      await ctx.commit(stream, cursor, async () => {});
      for (const m of items) { rec.mail.push(m); rec.knownMail.add(m.providerId); }
      ctx.count(stream, "added", items.length);
      return items.map((m) => m.providerId);
    },
    async fileVersion(_ctx, id) { return rec.versions.get(id) ?? null; },
    async file(ctx, stream, item) {
      const prev = rec.versions.get(item.externalId);
      if (prev === item.version) return "unchanged";
      rec.files.push(item);
      rec.versions.set(item.externalId, item.version);
      ctx.count(stream, prev ? "updated" : "added");
      return prev ? "updated" : "added";
    },
    async events(ctx, stream, items, removed, _name, _opts, cursor) {
      await ctx.commit(stream, cursor, async () => {});
      rec.events.push(...items);
      rec.removed.push(...removed);
    },
    async cursor(ctx, stream, cursor) { await ctx.commit(stream, cursor, async () => {}); },
  };
}

export type FakeRun<C> = RunContext<C> & { logs: string[]; counts: Record<string, StreamCounts>; setState(s: ConnectionState): void };

export function fakeCtx<C>(connector: string, config: C, state: ConnectionState = {}, now = new Date("2026-11-04T10:00:00Z")): FakeRun<C> {
  let st = state;
  const logs: string[] = [];
  const counts: Record<string, StreamCounts> = {};
  return {
    viewer: { id: "u1", graphId: "g1" } as unknown as RunContext["viewer"],
    connection: { id: "c1", graphId: "g1", userId: "u1", label: "Test", connector },
    runId: "r1", config, secrets: {}, now, signal: new AbortController().signal,
    state: () => st,
    async commit(stream, cursor, write) { await write({} as never); st = withCursor(st, stream, cursor, now); },
    count(stream, key, n = 1) { const c = (counts[stream] ??= {}); c[key] = (c[key] ?? 0) + n; },
    log(line) { logs.push(line); },
    proposed() {},
    async throttle() {},
    logs, counts,
    setState(s) { st = s; },
  };
}

/** Run a sync the way run.ts does: on CursorExpired, forget that stream's cursor and run once more. */
export async function runLikeTheApp<C>(ctx: FakeRun<C>, sync: (ctx: RunContext<C>, d: SyncDeps) => Promise<void>, d: SyncDeps): Promise<{ reset: string | null }> {
  try {
    await sync(ctx, d);
    return { reset: null };
  } catch (e) {
    if (!(e instanceof CursorExpired)) throw e;
    ctx.setState(resetStream(ctx.state(), e.stream));
    await sync(ctx, d);
    return { reset: `${e.stream}:${e.reason}` };
  }
}

export function deps(api: Api, sink: Sink): SyncDeps {
  return { api, sink, base: apiBase({ NODE_ENV: "test" }) };
}

/** A small RFC 822 message. */
export function rawMail(o: { id: string; subject: string; inReplyTo?: string; date?: string }): string {
  return [
    `Message-ID: <${o.id}@example.com>`, "From: Skolen <skole@example.com>", "To: Anna <anna@example.com>", `Subject: ${o.subject}`,
    `Date: ${o.date ?? "Mon, 02 Nov 2026 08:00:00 +0100"}`, ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}@example.com>`] : []),
    "Content-Type: text/plain; charset=utf-8", "", `Body of ${o.subject}`,
  ].join("\r\n");
}

export const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
