/**
 * Borrowing the parent's Aula sign-in for the widgets (server-only). No second MitID sign-in: this connector uses the
 * tokens of the person's own "Aula messages" connection in the same graph.
 *
 * Aula's refresh tokens may rotate, so only one run may hold and renew them at a time. While we read, we hold the Aula
 * connection's run lease (the same atomic claim its scheduler uses, run.ts claimOne): the Aula connection doesn't run
 * meanwhile, and we don't start while it runs ("busy, try again shortly"). A renewed token is saved back, encrypted, on
 * the Aula connection, where its next run picks it up. The lease is released when we are done (or ends by itself after
 * ten minutes if the app stops).
 *
 * The only Aula calls made: profiles.getProfilesByLogin and profiles.getProfileContext (through AulaApi, which can only
 * read) and aulaToken.getAulaToken (a short-lived token for one widget; it changes nothing in Aula).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import type { Transport } from "@/lib/mcp-client/transport";
import { decryptSecrets, encryptSecrets } from "../../crypto";
import { needsYou, willRetry } from "../../errors";
import type { RunContext } from "../../types";
import { AulaApi, AulaError } from "../aula/client";
import { aulaBases } from "../aula/constants";
import { needsRefresh, refreshTokens, tokensFrom, toSecrets, type AulaTokenSet } from "../aula/tokens";

export const needsAula = () => needsYou("Connect Aula messages in this graph first. This connection reads weekly plans and homework with that sign-in.", "schoolworkNeedsAula");
export const aulaReconnect = () => needsYou("Aula ended the sign-in. Reconnect Aula: open Connections, Aula messages, and sign in with MitID again.", "aulaReconnect");

/** The lease the scheduler uses (run.ts LEASE_MS, claimOne), taken on the Aula connection; copied here to keep the import graph acyclic. */
const LEASE_SECONDS = 600;
async function claimAulaLease(id: string, graphId: string): Promise<{ id: string; secrets: string | null; config: Record<string, unknown> } | null> {
  const leaseExpired = sql`coalesce((${connections.state}->>'leaseUntil')::timestamptz, 'epoch'::timestamptz) < now()`;
  const leaseSet = sql`jsonb_set(coalesce(${connections.state}, '{}'::jsonb), '{leaseUntil}', to_jsonb(to_char((now() + make_interval(secs => ${LEASE_SECONDS})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`;
  const rows = await db.update(connections).set({ state: leaseSet })
    .where(and(eq(connections.id, id), eq(connections.graphId, graphId), sql`${connections.status} <> 'paused'`, leaseExpired))
    .returning({ id: connections.id, secrets: connections.secrets, config: connections.config });
  return rows[0] ?? null;
}

export type AulaBorrow = {
  api: AulaApi;
  /** A token for one Aula widget ("Bearer …" as the providers expect it in Authorization). */
  widgetToken(widgetId: string): Promise<string>;
  release(): Promise<void>;
};

export async function borrowAula(ctx: RunContext, transport: Transport): Promise<AulaBorrow> {
  const [aula] = await db.select({ id: connections.id, status: connections.status }).from(connections)
    .where(and(eq(connections.graphId, ctx.connection.graphId), eq(connections.userId, ctx.connection.userId), eq(connections.connector, "aula")))
    .orderBy(desc(connections.updatedAt)).limit(1);
  if (!aula) throw needsAula();
  if (aula.status === "needs_you") throw needsYou("Aula messages needs you first: reconnect Aula, then this connection carries on by itself.", "aulaReconnect");
  if (aula.status === "paused") throw needsYou("Aula messages is paused. Resume it, and weekly plans and homework are read again.", "schoolworkAulaPaused");

  const row = await claimAulaLease(aula.id, ctx.connection.graphId);
  if (!row) throw willRetry("Aula messages is reading right now. Weekly plans are read when it is done.", "schoolworkAulaBusy");
  const release = async () => {
    await db.update(connections).set({ state: sql`jsonb_set(coalesce(${connections.state}, '{}'::jsonb), '{leaseUntil}', 'null'::jsonb)` })
      .where(eq(connections.id, row.id)).catch(() => {});
  };
  try {
    const cfg = (row.config ?? {}) as { aulaBase?: string; apiVersion?: number };
    const bases = aulaBases(cfg.aulaBase);
    let secrets: Record<string, string>;
    try { secrets = decryptSecrets(row.secrets, row.id); } catch { throw aulaReconnect(); }
    let tokens: AulaTokenSet | null = tokensFrom(secrets);
    if (!tokens) throw aulaReconnect();
    const renew = async () => {
      try {
        tokens = await refreshTokens(transport, bases.auth, tokens!.refreshToken, { signal: ctx.signal });
      } catch (e) {
        throw e instanceof AulaError && e.kind === "auth" ? aulaReconnect() : e;
      }
      await db.update(connections).set({ secrets: encryptSecrets(toSecrets(tokens), row.id), updatedAt: new Date() }).where(eq(connections.id, row.id));
      ctx.log("Renewed the Aula sign-in (saved on the Aula messages connection).");
    };
    if (needsRefresh(tokens)) await renew();
    const make = () => new AulaApi({ transport, apiBase: bases.api, accessToken: () => tokens!.accessToken, version: cfg.apiVersion ?? null, throttle: () => ctx.throttle(), signal: ctx.signal });
    let api = make();
    try {
      await api.ensureVersion();
    } catch (e) {
      if (!(e instanceof AulaError && e.kind === "auth")) throw e;
      await renew();
      api = make();
      await api.ensureVersion();
    }
    const widgetToken = async (widgetId: string): Promise<string> => {
      if (!/^\d{4,5}$/.test(widgetId)) throw new Error("Not a widget id.");
      await ctx.throttle();
      const q = new URLSearchParams({ method: "aulaToken.getAulaToken", widgetId, access_token: tokens!.accessToken });
      const res = await transport({ url: `${bases.api.replace(/\/$/, "")}/api/v${api.apiVersion}/?${q.toString()}`, method: "GET", headers: { accept: "application/json" }, signal: ctx.signal, timeoutMs: 30_000, maxBytes: 256 * 1024 })
        .catch(() => { throw new AulaError("Aula couldn't be reached.", "network"); });
      if (res.status === 401) throw aulaReconnect();
      if (res.status !== 200) throw new AulaError(`Aula answered HTTP ${res.status} to a widget token.`, "http", res.status);
      let data: unknown;
      try { data = (JSON.parse(res.body.toString("utf8")) as { data?: unknown }).data; } catch { throw new AulaError("Aula's answer wasn't JSON.", "envelope"); }
      if (typeof data !== "string" || data.length < 8) throw new AulaError("Aula gave no widget token (this login may not have the widget).", "envelope");
      return data.startsWith("Bearer ") ? data : `Bearer ${data}`;
    };
    return { api, widgetToken, release };
  } catch (e) {
    await release();
    throw e;
  }
}
