import { z } from "zod";
import { requireClinical } from "@/lib/clinical";
import { route } from "@/lib/clinical/http";
import { libraryDocuments } from "@/lib/clinical/views";

export const dynamic = "force-dynamic";

/** GET ?q=: documents in the practice graph's library (to attach a signed consent or read lab results from). */
export const GET = route(async (req, v) => {
  await requireClinical(v);
  const q = z.string().trim().max(100).optional().parse(new URL(req.url).searchParams.get("q") ?? undefined);
  return { documents: await libraryDocuments(v, q || undefined) };
});
