import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { audit } from "@/lib/auth";
import { ConnectionError } from "@/lib/connectors";
import { parseId, parseJson, route } from "@/lib/connectors/http";
import { enabledTools, mcpConfig } from "@/lib/connectors/mcp/config";
import { MCP_CONNECTORS } from "@/lib/connectors/registry";
import { scopeOf } from "@/lib/graphs/pure";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function own(v: Parameters<Parameters<typeof route>[0]>[1], id: string) {
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
  if (!row || !MCP_CONNECTORS.has(row.connector)) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
  const cfg = mcpConfig.safeParse(row.config);
  if (!cfg.success) throw new ConnectionError(400, "This connection's settings need fixing.");
  return { row, config: cfg.data };
}

/** GET: what the server offers (as last read) and which tools the assistant may use in this graph. */
export const GET = route(async (_req, v, { params }: Ctx) => {
  const { config } = await own(v, parseId((await params).id));
  return {
    serverName: config.serverName ?? null, catalogAt: config.catalogAt ?? null, chosen: !!config.toolsChosen,
    tools: (config.tools ?? []).map((t) => ({ name: t.name, title: t.title ?? null, description: t.description ?? null, writes: t.writes })),
    resources: config.resources ?? [], enabled: enabledTools(config),
  };
});

const patch = z.object({ enabled: z.array(z.string().max(128)).max(300) });

/** PATCH { enabled: [tool names] }: the tools the assistant may use in this graph (writing ones still ask each time). */
export const PATCH = route(async (req, v, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (v.role === "guest" || !scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not change its connections.");
  const { config } = await own(v, id);
  const { enabled } = await parseJson(req, patch);
  const offered = new Set((config.tools ?? []).map((t) => t.name));
  const unknown = enabled.filter((n) => !offered.has(n));
  if (unknown.length) throw new ConnectionError(400, `The server doesn't offer ${unknown.slice(0, 3).join(", ")}.`);
  const next = { ...config, allowedTools: [...new Set(enabled)], toolsChosen: true };
  await db.update(connections).set({ config: next, updatedAt: new Date() }).where(and(eq(connections.id, id), eq(connections.userId, v.id)));
  const writes = (config.tools ?? []).filter((t) => t.writes && enabled.includes(t.name)).map((t) => t.name);
  void audit(v, "connections.tools", { type: "connection", id }, { enabled: next.allowedTools.length, writes }).catch(() => {});
  return { enabled: next.allowedTools };
});
