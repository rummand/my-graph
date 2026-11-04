import { z } from "zod";
import { disconnect, getConnection, importedCount, updateConnection } from "@/lib/connectors";
import { parseId, parseJson, patchBody, route } from "@/lib/connectors/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET: one of my connections with its last 30 runs, and how many items it brought in. */
export const GET = route(async (_req, v, { params }: Ctx) => {
  const id = parseId((await params).id);
  const detail = await getConnection(v, id);
  return { ...detail, imported: await importedCount(v, id) };
});

/** PATCH { label?, config?, secrets?, everyMinutes?, paused? }: empty secrets keep the saved ones. */
export const PATCH = route(async (req, v, { params }: Ctx) => {
  const id = parseId((await params).id);
  const body = await parseJson(req, patchBody);
  return { connection: await updateConnection(v, id, body) };
});

const keepQuery = z.enum(["true", "false"]).default("true");

/** DELETE ?keep=true|false: disconnect, keeping or removing what it brought in. */
export const DELETE = route(async (req, v, { params }: Ctx) => {
  const id = parseId((await params).id);
  const keep = keepQuery.safeParse(new URL(req.url).searchParams.get("keep") ?? undefined);
  if (!keep.success) return Response.json({ error: "keep must be true or false." }, { status: 400 });
  return await disconnect(v, id, { keep: keep.data === "true" });
});
