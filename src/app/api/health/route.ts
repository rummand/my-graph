import { NextResponse } from "next/server";
import { sql } from "@/db";

export const dynamic = "force-dynamic";

/** Liveness for Railway: 200 when the database answers. mux being down only degrades the app, so it never fails the check. */
export async function GET() {
  let db = false;
  try {
    await sql`select 1`;
    db = true;
  } catch {
    db = false;
  }

  let mux: { ok: boolean; detail: string };
  try {
    const base = (process.env.MUX_BASE_URL || "http://127.0.0.1:7070").replace(/\/$/, "");
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    mux = { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch {
    // Unauthenticated endpoint: don't echo error text (it can name internal hosts and ports).
    mux = { ok: false, detail: "unreachable" };
  }

  return NextResponse.json({ ok: db, db, mux }, { status: db ? 200 : 503 });
}
