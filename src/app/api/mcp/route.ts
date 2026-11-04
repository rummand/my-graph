import { notHere, preflight, serveMcp } from "@/lib/mcp-server";

/** POST /api/mcp: My Graph's MCP server (Streamable HTTP, JSON answers, stateless). See src/lib/mcp-server. */
export const dynamic = "force-dynamic";
export const POST = (req: Request) => serveMcp(req);
export const GET = notHere;
export const DELETE = notHere;
export const OPTIONS = preflight;
