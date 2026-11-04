import { NextResponse } from "next/server";
import { authorizationServerMetadata, CORS, originOf, preflight } from "@/lib/mcp-server";

/** RFC 8414: My Graph's OAuth authorization server, for its MCP server. */
export const dynamic = "force-dynamic";
export const GET = (req: Request) => NextResponse.json(authorizationServerMetadata(originOf(req)), { headers: { ...CORS, "cache-control": "public, max-age=3600" } });
export const OPTIONS = preflight;
