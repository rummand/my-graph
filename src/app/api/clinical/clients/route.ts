import { NextResponse } from "next/server";
import { parseBody, route } from "@/lib/clinical/http";
import { createClient, listClients } from "@/lib/clinical";
import { createClientBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";

/** GET: the clients and patients I may open. POST { name, discipline, reason }: a new one. */
export const GET = route(async (_req, v) => ({
  clients: (await listClients(v)).map((c) => ({ id: c.id, label: c.label, kind: c.kind, discipline: c.discipline, access: c.access, ownerName: c.ownerName, consent: c.consent.state })),
}));
export const POST = route(async (req, v) => NextResponse.json(await createClient(v, await parseBody(req, createClientBody)), { status: 201 }));
