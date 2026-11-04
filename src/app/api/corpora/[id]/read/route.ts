import { startReading } from "@/lib/corpus";
import { readBody } from "@/lib/corpus/schemas";
import { parseBody, route, uuid } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { mode: read | version, version? }: read the rules from the corpus's documents in the background. */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  const body = await parseBody(req, readBody);
  return { readState: await startReading(v, id, { mode: body.mode, version: body.version ?? null }) };
});
