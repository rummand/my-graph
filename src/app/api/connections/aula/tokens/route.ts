/**
 * POST /api/connections/aula/tokens: the Connect Aula helper hands in the tokens from the parent's MitID sign-in, with
 * the one-time pairing code My Graph showed them. There is no session here (the helper is a script on the parent's
 * computer): the code is the proof, used once, valid 15 minutes, rate limited. A browser on another site is refused
 * by the same-origin check in middleware (it sends Origin); the helper sends none. Tokens are never returned or logged.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/auth/rate-limit";
import { ConnectionError } from "@/lib/connectors";
import { parseJson } from "@/lib/connectors/http";
import { acceptTokens } from "@/lib/connectors/dk/aula/pairing";

const body = z.object({
  pairingCode: z.string().trim().min(10, "Enter the pairing code My Graph showed you.").max(20),
  accessToken: z.string().min(8).max(8000),
  refreshToken: z.string().min(8).max(8000),
  expiresIn: z.number().int().min(1).max(30 * 86_400).optional(),
  expiresAt: z.number().int().min(0).optional(),
  aulaBase: z.string().url().max(200).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const input = await parseJson(req, body);
    const out = await acceptTokens(input, clientIp(req.headers));
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof ConnectionError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    console.error("[aula pairing]", e instanceof Error ? e.message : "failed");
    return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 });
  }
}
