import { getSession } from "@/lib/auth";

/** GET: the state of this browser's session — used by the "waiting for approval" page to poll. */
export async function GET() {
  try {
    const s = await getSession();
    return Response.json({ status: s.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[auth] status", err);
    return Response.json({ error: "Couldn't check your session." }, { status: 500 });
  }
}
