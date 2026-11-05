/**
 * The assistant's way to MCP servers (server-only), for the chat workstream to call:
 *
 *   listMcpTools(v)  → the tools the viewer's MCP connections in this graph allow, each with a qualified name
 *                      (`mcp__<connection>__<tool>`), its description, input schema and whether it writes.
 *   callMcpTool(v, { name | connectionId+tool, args, approval? })
 *                    → { status: "ok", text, data, isError }            (text is wrapped as untrusted data)
 *                    | { status: "needs_approval", approval }           (a writing tool: show the approval card)
 *                    | { status: "not_allowed" | "unavailable", message }
 *
 * Rules: only the viewer's own connections in the viewer's current graph; only tools the graph allows (a person's
 * choice on the connection's page); a tool that writes is classified from the server's live tool list (not from what
 * is stored), and every call to one needs `approval`: a signed token from the card, bound to this person, connection,
 * tool and exact arguments, valid 10 minutes and once (recorded in Postgres, so a restart can't reuse it), posted by
 * the person themself. A tool's answer is data, never instructions.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { McpClient } from "@/lib/mcp-client/client";
import { LIMITS } from "@/lib/security/limits";
import { oneTimeTokens, type OneTimeTokens } from "@/lib/security/once";
import { limiter } from "@/lib/security/rate-limit";
import { McpError } from "@/lib/mcp-client/errors";
import { asUntrustedData, type McpToolInfo } from "@/lib/mcp-client/tools";
import { guardedTransport } from "@/lib/mcp-client/transport";
import { connectorKey, decryptSecrets } from "../crypto";
import { ConnectorError } from "../errors";
import { MCP_CONNECTORS } from "../registry";
import { bearerFor } from "./auth";
import { enabledTools, mcpConfig, type McpConfig } from "./config";

export type McpToolForAssistant = {
  name: string; connectionId: string; connection: string; server: string | null; tool: string;
  title: string | null; description: string | null; inputSchema: Record<string, unknown> | null; writes: boolean;
};

export type McpApproval = {
  token: string; connectionId: string; connection: string; server: string | null; tool: string; title: string | null;
  description: string | null; args: Record<string, unknown>; expiresAt: string;
};

export type McpCallResult =
  | { status: "ok"; isError: boolean; text: string; data: unknown }
  | { status: "needs_approval"; approval: McpApproval }
  | { status: "not_allowed" | "unavailable"; message: string };

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "server";

export function qualifiedName(connectionLabel: string, connectionId: string, tool: string): string {
  return `mcp__${slug(connectionLabel)}_${connectionId.slice(0, 4)}__${tool}`.slice(0, 128);
}

async function ownMcpConnections(v: Viewer, id?: string) {
  const rows = await db.select().from(connections).where(and(
    eq(connections.graphId, v.graphId), eq(connections.userId, v.id), inArray(connections.connector, [...MCP_CONNECTORS]),
    ...(id ? [eq(connections.id, id)] : []),
  ));
  return rows.flatMap((r) => {
    const cfg = mcpConfig.safeParse(r.config);
    return cfg.success && r.status !== "paused" ? [{ row: r, config: cfg.data }] : [];
  });
}

/** Every tool the assistant may use in the viewer's current graph. */
export async function listMcpTools(v: Viewer): Promise<McpToolForAssistant[]> {
  const out: McpToolForAssistant[] = [];
  for (const { row, config } of await ownMcpConnections(v)) {
    const on = new Set(enabledTools(config));
    for (const t of config.tools ?? []) {
      if (!on.has(t.name)) continue;
      out.push({
        name: qualifiedName(row.label, row.id, t.name), connectionId: row.id, connection: row.label, server: config.serverName ?? null, tool: t.name,
        title: t.title ?? null, description: t.description ?? null, inputSchema: (t.inputSchema as Record<string, unknown> | null | undefined) ?? null, writes: t.writes,
      });
    }
  }
  return out;
}

/* ── Approval tokens ─────────────────────────────────────────────────────────────────────────────────── */

const APPROVAL_MS = 10 * 60_000;

function argsHash(args: Record<string, unknown>): string {
  const canon = (x: unknown): unknown => Array.isArray(x) ? x.map(canon) : x && typeof x === "object"
    ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])])) : x;
  return createHash("sha256").update(JSON.stringify(canon(args))).digest("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", connectorKey()).update(`mcp-approval|${payload}`).digest("base64url");
}

export function approvalToken(p: { userId: string; graphId: string; connectionId: string; tool: string; args: Record<string, unknown>; expiresAt: number }): string {
  const payload = Buffer.from(JSON.stringify({ u: p.userId, g: p.graphId, c: p.connectionId, t: p.tool, h: argsHash(p.args), e: p.expiresAt })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Does this token approve exactly this call, by this person, now? */
export function approvalValid(token: string, p: { userId: string; graphId: string; connectionId: string; tool: string; args: Record<string, unknown> }, now = Date.now()): boolean {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const want = Buffer.from(sign(payload)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u: string; g: string; c: string; t: string; h: string; e: number };
    return o.u === p.userId && o.g === p.graphId && o.c === p.connectionId && o.t === p.tool && o.h === argsHash(p.args) && o.e > now;
  } catch {
    return false;
  }
}

/** When a token stops being valid on its own (0 when it can't be read). */
function expiryOf(token: string): number {
  try {
    const o = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { e?: unknown };
    return typeof o.e === "number" ? o.e : 0;
  } catch {
    return 0;
  }
}

/**
 * Mark a valid token as used: each approval runs its call once, anywhere. Recorded in Postgres (`used_approvals`,
 * a hash of the token, kept until the token would have expired anyway) behind an in-memory cache, so a restart or a
 * second server process can't run the same approval twice. False when it was already used.
 */
export async function spendApproval(token: string, now = Date.now(), tokens: OneTimeTokens = oneTimeTokens(), userId: string | null = null): Promise<boolean> {
  const mac = token.split(".")[1] ?? token;
  return tokens.spend("mcp-approval", mac, Math.max(expiryOf(token), now + APPROVAL_MS), userId, now);
}

/* ── Calling ─────────────────────────────────────────────────────────────────────────────────────────── */

const g = globalThis as unknown as { __mgMcpLive?: Map<string, { at: number; tools: McpToolInfo[] }> };
const live = (g.__mgMcpLive ??= new Map());

function clientOf(row: { id: string }, config: McpConfig, secrets: Record<string, string>): McpClient {
  const transport = guardedTransport();
  return new McpClient({ url: config.serverUrl, transport, perMinute: 60, timeoutMs: 45_000, token: () => bearerFor({ id: row.id, config }, secrets, transport) });
}

async function liveTools(row: { id: string }, client: McpClient): Promise<McpToolInfo[]> {
  const hit = live.get(row.id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.tools;
  const tools = await client.listTools();
  live.set(row.id, { at: Date.now(), tools });
  return tools;
}

export async function callMcpTool(v: Viewer, input: { name?: string; connectionId?: string; tool?: string; args?: Record<string, unknown>; approval?: string }): Promise<McpCallResult> {
  const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args : {};
  const all = await ownMcpConnections(v, input.connectionId);
  let found: { row: (typeof all)[number]["row"]; config: McpConfig; tool: string } | null = null;
  for (const c of all) {
    const tool = input.tool ?? (input.name ?? "").split("__").slice(2).join("__");
    if (input.name && qualifiedName(c.row.label, c.row.id, tool) !== input.name) continue;
    found = { ...c, tool };
    break;
  }
  if (!found || !found.tool) return { status: "unavailable", message: "There is no such tool among your connections in this graph." };
  const { row, config, tool } = found;
  if (!enabledTools(config).includes(tool)) return { status: "not_allowed", message: `“${tool}” isn't turned on for this graph. It can be turned on under Connections, ${row.label}.` };

  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(row.secrets, row.id); } catch { return { status: "unavailable", message: `${row.label}'s sign-in can't be read. Sign in again under Connections.` }; }
  const client = clientOf(row, config, secrets);
  try {
    const info = (await liveTools(row, client)).find((t) => t.name === tool);
    if (!info) return { status: "unavailable", message: `${row.label} no longer offers “${tool}”.` };
    if (info.writes) {
      const ok = !!input.approval && approvalValid(input.approval, { userId: v.id, graphId: v.graphId, connectionId: row.id, tool, args })
        && await spendApproval(input.approval, Date.now(), undefined, v.id);
      if (!ok) {
        // Approval cards are cheap to mint; a loop asking for them again and again is stopped here.
        const room = await limiter().hit(LIMITS.mcpApprovals, `user|${v.id}`);
        if (!room.allowed) return { status: "unavailable", message: `Too many approvals asked for in a short time. Try again in ${room.retryAfterSec} seconds.` };
        const expiresAt = Date.now() + APPROVAL_MS;
        return {
          status: "needs_approval",
          approval: {
            token: approvalToken({ userId: v.id, graphId: v.graphId, connectionId: row.id, tool, args, expiresAt }),
            connectionId: row.id, connection: row.label, server: config.serverName ?? null, tool, title: info.title, description: info.description, args, expiresAt: new Date(expiresAt).toISOString(),
          },
        };
      }
      void audit(v, "mcp.call.write", { type: "connection", id: row.id }, { tool }).catch(() => {});
    }
    const r = await client.callTool(tool, args);
    return { status: "ok", isError: r.isError, data: r.data, text: asUntrustedData(config.serverName ?? row.label, tool, r.text) };
  } catch (e) {
    if (e instanceof ConnectorError || e instanceof McpError) return { status: "unavailable", message: e.message };
    throw e;
  }
}
