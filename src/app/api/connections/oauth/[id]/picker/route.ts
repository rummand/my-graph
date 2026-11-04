import { NextResponse } from "next/server";
import { ConnectionError } from "@/lib/connectors";
import { parseId, route } from "@/lib/connectors/http";
import { pickerToken } from "@/lib/connectors/oauth/flow";
import { pickerSettings } from "@/lib/connectors/oauth/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST → what Google's file picker needs to open in the person's browser: their own access token for this Drive
 * connection (drive.file scope only, about an hour), the picker's browser key and the app id. This is the one place a
 * token reaches a browser, because Google's picker runs there; it goes only to the connection's owner, same-origin,
 * never cached, and the token can only see files the person picks.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, v, { params }) => {
  const id = parseId((await params).id);
  const s = pickerSettings();
  if (!s) throw new ConnectionError(400, "The Drive picker isn't set up on this My Graph (GOOGLE_PICKER_API_KEY is missing).", "pickerNotSetUp");
  const t = await pickerToken(v, id);
  return NextResponse.json({ ...t, developerKey: s.developerKey, appId: s.appId }, { headers: { "cache-control": "no-store" } });
});
