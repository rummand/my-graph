import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/lib/auth";
import { loadLedger, personCommitments } from "@/lib/commitments";
import { getPrefs } from "@/lib/i18n";
import { handle, jsonError } from "./http";

export const dynamic = "force-dynamic";

const query = z.object({ person: z.uuid().optional(), status: z.enum(["open", "all"]).optional() }).strict();

/**
 * GET /api/commitments → { ledger } (everything the /commitments page shows, in the current graph).
 * GET /api/commitments?person=<id>&status=open → { items } (open ones that person is responsible for).
 */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUserApi();
    const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) return jsonError(400, q.error.issues[0]?.message ?? "That query isn't valid.");
    const { timeZone } = await getPrefs();
    if (q.data.person && q.data.status !== "all") {
      return NextResponse.json({ items: await personCommitments(v, q.data.person, new Date(), timeZone) });
    }
    return NextResponse.json({ ledger: await loadLedger(v, { tz: timeZone, personId: q.data.person ?? null }) });
  });
}
