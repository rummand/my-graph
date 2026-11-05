/**
 * Pairing the Connect Aula helper with My Graph (server-only).
 *
 * 1. In My Graph the parent asks for a pairing code (startPairing). That makes (or reuses) their one Aula connection
 *    in this graph, waiting for a sign-in, and stores only a hash of the code, valid for 15 minutes.
 * 2. The helper, on the parent's own computer at home, signs in to Aula with MitID (in the parent's browser) and posts
 *    the resulting tokens here with the code (acceptTokens). No session cookie: the code is the proof, used once,
 *    rate limited per address and overall.
 * 3. The tokens are checked against Aula, stored encrypted on the connection, the code is spent, and the first check
 *    starts. MitID credentials never reach My Graph; tokens are never returned, logged or sent to mux.
 */
import { createHash, randomInt } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { AttemptLimiter } from "@/lib/auth/rate-limit";
import { viewerFor } from "@/lib/auth/viewer-for";
import { scopeOf } from "@/lib/graphs/pure";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { encryptSecrets } from "../../crypto";
import { ConnectionError, getConnection, kick, type ConnectionDTO } from "../../store";
import { AulaApi, AulaError } from "./client";
import { aulaBases } from "./constants";
import { aulaConfig } from "./connector";
import { accountFrom } from "./mapping";
import { toSecrets } from "./tokens";

export const PAIRING_MINUTES = 15;
/** Unambiguous letters and digits (no 0/O, 1/I/L): 10 of them ≈ 49 bits, valid 15 minutes, a few tries per address. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** What people type: case, spaces and dashes don't matter. */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function pairingHash(code: string): string {
  return createHash("sha256").update(`my-graph aula pairing|${normaliseCode(code)}`).digest("hex");
}

const g = globalThis as unknown as { __mgAulaPairIp?: AttemptLimiter; __mgAulaPairAll?: AttemptLimiter };
const perAddress = g.__mgAulaPairIp ?? (g.__mgAulaPairIp = new AttemptLimiter(10, 15 * 60_000));
const overall = g.__mgAulaPairAll ?? (g.__mgAulaPairAll = new AttemptLimiter(60, 15 * 60_000));

function assertMayConnect(v: Viewer) {
  if (v.role === "guest") throw new ConnectionError(403, "Guests can't connect accounts.");
  if (!scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not connect accounts to it.");
  if (v.graphKind !== "family") throw new ConnectionError(400, "Aula messages can only be connected to a family graph.");
}

async function ownAula(v: Viewer) {
  const [row] = await db.select().from(connections)
    .where(and(eq(connections.graphId, v.graphId), eq(connections.userId, v.id), eq(connections.connector, "aula"))).limit(1);
  return row ?? null;
}

export type AulaStatus = {
  connection: ConnectionDTO | null;
  pairing: { expiresAt: string } | null;
  signedIn: boolean;
  account: { name: string | null; children: { name: string; institution: string | null }[] } | null;
};

export async function aulaStatus(v: Viewer): Promise<AulaStatus> {
  const row = await ownAula(v);
  if (!row) return { connection: null, pairing: null, signedIn: false, account: null };
  const { connection } = await getConnection(v, row.id);
  const cfg = aulaConfig.safeParse(row.config);
  const p = cfg.success ? cfg.data.pairing : null;
  const live = p && Date.parse(p.expiresAt) > Date.now() ? { expiresAt: p.expiresAt } : null;
  return { connection, pairing: live, signedIn: connection.secretsSaved.includes("refreshToken"), account: cfg.success ? cfg.data.account ?? null : null };
}

/** A fresh one-time code for this person's Aula connection in this graph (made now if there is none). */
export async function startPairing(v: Viewer, input: { visibility?: "private" | "parents" | "household"; aulaBase?: string } = {}): Promise<{ code: string; expiresAt: string; connectionId: string }> {
  assertMayConnect(v);
  const code = newPairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
  const pairing = { hash: pairingHash(code), expiresAt };
  const existing = await ownAula(v);
  if (existing) {
    const merged = aulaConfig.parse({ ...(existing.config ?? {}), pairing, ...(input.visibility ? { visibility: input.visibility } : {}), ...(input.aulaBase ? { aulaBase: input.aulaBase } : {}) });
    await db.update(connections).set({ config: merged, updatedAt: new Date() }).where(eq(connections.id, existing.id));
    void audit(v, "connections.aula.pairing", { type: "connection", id: existing.id }, {}).catch(() => {});
    return { code, expiresAt, connectionId: existing.id };
  }
  const id = crypto.randomUUID();
  const config = aulaConfig.parse({ visibility: input.visibility ?? "parents", pairing, feedHost: "aula.dk", ...(input.aulaBase ? { aulaBase: input.aulaBase } : {}) });
  await db.insert(connections).values({
    id, graphId: v.graphId, userId: v.id, connector: "aula", label: "Aula messages", config, secrets: encryptSecrets({}, id), state: {},
    status: "needs_you", statusDetail: "aulaAwaitingSignIn|Waiting for you to sign in to Aula with the Connect Aula helper.", everyMinutes: 15, nextRunAt: null,
  });
  void audit(v, "connections.create", { type: "connection", id }, { connector: "aula" }).catch(() => {});
  return { code, expiresAt, connectionId: id };
}

export type TokenHandIn = { pairingCode: string; accessToken: string; refreshToken: string; expiresIn?: number; expiresAt?: number; aulaBase?: string };

/**
 * The helper hands in the tokens. Checked against Aula (one read) before they are kept, unless Aula can't be reached
 * from here right now, in which case they are kept and the first check says how it went.
 */
export async function acceptTokens(input: TokenHandIn, ip: string, transport: Transport = guardedTransport()): Promise<{ label: string; account: AulaStatus["account"] }> {
  const ipKey = `aula-pair|${ip}`;
  for (const [lim, key] of [[perAddress, ipKey], [overall, "aula-pair|all"]] as const) {
    const c = lim.check(key);
    if (!c.allowed) throw new ConnectionError(429, `Too many tries. Wait ${Math.ceil(c.retryAfterSec / 60)} minutes and make a new pairing code.`);
  }
  const hash = pairingHash(input.pairingCode);
  const [row] = await db.select().from(connections)
    .where(and(eq(connections.connector, "aula"), sql`${connections.config}->'pairing'->>'hash' = ${hash}`)).limit(1);
  const cfg = row ? aulaConfig.safeParse(row.config) : null;
  if (!row || !cfg?.success || !cfg.data.pairing || Date.parse(cfg.data.pairing.expiresAt) <= Date.now()) {
    perAddress.fail(ipKey);
    overall.fail("aula-pair|all");
    throw new ConnectionError(400, "That pairing code isn't valid or has run out. Make a new one in My Graph (Connections, Aula messages).", "aulaBadCode");
  }
  const v = await viewerFor(row.userId, row.graphId);
  if (!v || !scopeOf(v).canWrite) throw new ConnectionError(403, "The person who made this code can no longer connect accounts to that graph.");

  const now = Date.now();
  const expiresAt = input.expiresAt && input.expiresAt > now ? input.expiresAt : now + Math.max(60, Math.min(input.expiresIn ?? 3600, 86_400)) * 1000;
  const tokens = { accessToken: input.accessToken, refreshToken: input.refreshToken, expiresAt };
  const base = cfg.data.aulaBase ?? input.aulaBase;
  const bases = aulaBases(base);

  let account: AulaStatus["account"] = null;
  let apiVersion = cfg.data.apiVersion;
  try {
    const api = new AulaApi({ transport, apiBase: bases.api, accessToken: () => tokens.accessToken, version: apiVersion ?? null, timeoutMs: 15_000 });
    const a = accountFrom(await api.profilesByLogin());
    account = { name: a.name, children: a.children.map((c) => ({ name: c.name, institution: c.institutionName })) };
    apiVersion = api.apiVersion;
  } catch (e) {
    if (e instanceof AulaError && (e.kind === "auth" || e.kind === "deactivated")) {
      throw new ConnectionError(400, "Aula didn't accept this sign-in. Run the helper again and approve in the MitID app.", "aulaRefused");
    }
    // Aula unreachable from here just now: keep the tokens; the first check will say how it goes.
  }

  const config = aulaConfig.parse({
    ...cfg.data, pairing: null, ...(account ? { account } : {}), ...(apiVersion ? { apiVersion } : {}),
    ...(base && !cfg.data.aulaBase ? { aulaBase: base } : {}),
  });
  const label = account?.name ? `Aula: ${account.name}` : row.label;
  // Spend the code in the same statement that stores the tokens (a second hand-in with the same code finds nothing).
  const updated = await db.update(connections).set({
    secrets: encryptSecrets(toSecrets(tokens), row.id), config, label, status: "ok", statusDetail: null, nextRunAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(connections.id, row.id), sql`${connections.config}->'pairing'->>'hash' = ${hash}`)).returning({ id: connections.id });
  if (!updated.length) throw new ConnectionError(400, "That pairing code was just used. Make a new one in My Graph.", "aulaBadCode");
  perAddress.reset(ipKey);
  void audit(v, "connections.aula.signedIn", { type: "connection", id: row.id }, { children: account?.children.length ?? null }).catch(() => {});
  kick(row.id, row.graphId);
  return { label, account };
}
