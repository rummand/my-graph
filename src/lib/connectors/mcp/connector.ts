/**
 * "MCP server": any Model Context Protocol server, by its address, signed in with an API key or OAuth. A run reads
 * what the server offers (its tools and resources) and keeps that catalog on the connection, so the person can choose
 * which tools the assistant may use in this graph. Tools that write are off until a person turns them on, and each
 * use of one still waits for a person's approval. Nothing a server says is followed as an instruction.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { connections } from "@/db/schema";
import { McpClient } from "@/lib/mcp-client/client";
import { McpError, needsPerson } from "@/lib/mcp-client/errors";
import { checkServerUrl, guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import type { McpToolInfo } from "@/lib/mcp-client/tools";
import { ConnectorError, needsYou, willRetry } from "../errors";
import { defineManifest } from "../manifest";
import type { Connector, RunContext, Tx } from "../types";
import { bearerFor } from "./auth";
import { mcpConfig, mcpSecrets, readOAuth, type McpConfig } from "./config";

export const mcpManifest = defineManifest({
  id: "mcp", version: "1", status: "official", icon: "plug",
  auth: { type: "oauth2" },
  config: mcpConfig,
  secrets: mcpSecrets,
  fields: [
    { key: "serverUrl", kind: "url", required: true, placeholder: "https://…/mcp" },
    { key: "apiKey", kind: "password", secret: true },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [{ name: "catalog", key: "name", cursor: "catalogAt", resetOn: [] }],
  schedule: { everyMinutes: 24 * 60 },
  rateLimit: { perMinute: 30, backoff: "exponential" },
  maps: { catalog: "catalog" },
});

/** An MCP problem as the connection's status: needs you (sign in, fix the address) or will retry. */
export function asConnectorError(e: unknown): unknown {
  if (!(e instanceof McpError)) return e;
  if (e.code === "auth") return needsYou("The server wants you to sign in again.", "signIn");
  if (e.code === "forbidden") return needsYou("The server refused: the key or sign-in may not read this.", "forbidden");
  if (e.code === "privateHost") return needsYou(e.message, "privateHost");
  if (e.code === "badUrl") return needsYou(e.message, "badUrl");
  if (e.code === "http" && (e.extra.status === 404 || e.extra.status === 405)) return needsYou("Nothing answers MCP at that address. Check that it ends in the MCP path (often /mcp).", "notMcp");
  if (needsPerson(e)) return needsYou(e.message, "mcpOther");
  if (e.code === "rateLimited") return willRetry(e.message, "rateLimited");
  if (e.code === "timeout") return willRetry(e.message, "timeout");
  return willRetry(e.message, e.code === "serverError" ? "serverError" : "network");
}

export function clientFor(ctx: Pick<RunContext<McpConfig>, "connection" | "config" | "secrets" | "signal">, opts: { perMinute: number; transport?: Transport }): McpClient {
  const transport = opts.transport ?? guardedTransport();
  return new McpClient({
    url: ctx.config.serverUrl, transport, perMinute: opts.perMinute, signal: ctx.signal, timeoutMs: 45_000,
    token: () => bearerFor({ id: ctx.connection.id, config: ctx.config }, ctx.secrets, transport),
  });
}

/** Keep the catalog on the connection's config (merged, so a person's choices stay). */
export async function saveCatalog(tx: Tx, connectionId: string, catalog: { serverName: string | null; tools: McpToolInfo[]; resources: { uri: string; name: string; description: string | null }[] }): Promise<void> {
  const patch = {
    serverName: catalog.serverName,
    tools: catalog.tools.slice(0, 300).map((t) => ({
      name: t.name, title: t.title, description: t.description, writes: t.writes,
      inputSchema: t.inputSchema && JSON.stringify(t.inputSchema).length <= 8000 ? t.inputSchema : null,
    })),
    resources: catalog.resources.slice(0, 300).map((r) => ({ uri: r.uri, name: r.name, description: r.description })),
    catalogAt: new Date().toISOString(),
  };
  await tx.update(connections).set({ config: sql`coalesce(${connections.config}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` }).where(eq(connections.id, connectionId));
}

/** Read the server's tools and resources and keep them. Returns the tools (for the Record sync's capabilities). */
export async function syncCatalog(ctx: RunContext<McpConfig>, client: McpClient): Promise<McpToolInfo[]> {
  await ctx.throttle();
  const info = await client.initialize();
  const tools = await client.listTools();
  const resources = await client.listResources().catch(() => []);
  ctx.count("catalog", "fetched", tools.length);
  await ctx.commit("catalog", { at: new Date().toISOString(), tools: tools.length, resources: resources.length }, (tx) =>
    saveCatalog(tx, ctx.connection.id, { serverName: info.title ?? info.name, tools, resources }));
  const writes = tools.filter((t) => t.writes).length;
  ctx.log(`${info.title ?? info.name ?? "The server"} offers ${tools.length} ${tools.length === 1 ? "tool" : "tools"}${writes ? ` (${writes} that change things, off until you turn them on)` : ""} and ${resources.length} ${resources.length === 1 ? "resource" : "resources"}.`);
  return tools;
}

export function checkMcp(c: McpConfig, s: Record<string, string>): void {
  checkServerUrl(c.serverUrl);
  if (c.authMode === "key" && !s.apiKey) throw needsYou("Paste an API key, or choose to sign in instead.", "missingKey");
  if (c.authMode === "oauth" && !readOAuth(s)?.accessToken) throw needsYou("Use “Sign in” to connect this server.", "signIn");
}

/** Run a body and turn MCP problems into the connection's status. */
export async function withMcpErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw asConnectorError(e);
  }
}

export const mcpConnector: Connector<McpConfig> = {
  manifest: mcpManifest,
  check(c, s) {
    try {
      checkMcp(c, s);
    } catch (e) {
      throw asConnectorError(e);
    }
  },
  describe(c) {
    try { return { feedHost: new URL(c.serverUrl).hostname }; } catch { return {}; }
  },
  sync: (ctx) => withMcpErrors(async () => {
    await syncCatalog(ctx, clientFor(ctx, { perMinute: mcpManifest.rateLimit.perMinute }));
  }),
};

export const mcpConfigSchema: z.ZodType<McpConfig> = mcpConfig as unknown as z.ZodType<McpConfig>;
