import { NextResponse } from "next/server";
import { CORS, originOf, preflight, protectedResourceMetadata } from "@/lib/mcp-server";

/** RFC 9728: what the MCP server is and who signs people in to it. */
export const dynamic = "force-dynamic";
export const GET = (req: Request) => NextResponse.json(protectedResourceMetadata(originOf(req)), { headers: { ...CORS, "cache-control": "public, max-age=3600" } });
export const OPTIONS = preflight;
