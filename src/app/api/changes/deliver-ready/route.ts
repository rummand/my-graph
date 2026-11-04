import { z } from "zod";
import { deliverChangeSet, getChangeSet } from "@/lib/changes";
import { body, HttpError, route } from "@/lib/changes/http";
import { canWrite } from "@/lib/changes/store";

const schema = z.object({
  sets: z.array(z.object({ id: z.uuid(), fingerprint: z.string().trim().max(64).nullable().optional() }).strict()).min(1).max(100),
}).strict();

/**
 * POST /api/changes/deliver-ready { sets: [{ id, fingerprint }] } → { delivered: [{ id, applied, connected }], kept: [{ id, why }] }.
 * "Deliver all ready": delivers each listed proposal in which nothing needs a person, with the fingerprint the list
 * was shown with (so one that changed since is kept back, not delivered unseen). Each set is its own transaction.
 */
export const POST = route(async (req, v) => {
  if (!canWrite(v)) throw new HttpError(403, "You can look at this graph but not change it, so someone who can has to deliver these.");
  const { sets } = await body(req, schema);
  const delivered: { id: string; title: string; applied: number; connected: number }[] = [];
  const kept: { id: string; title: string | null; why: "stale" | "needsYou" | "gone" | "failed"; error?: string }[] = [];
  for (const s of sets) {
    const cs = await getChangeSet(v, s.id);
    if (!cs || cs.status !== "draft") { kept.push({ id: s.id, title: cs?.title ?? null, why: "gone" }); continue; }
    if (s.fingerprint && cs.fingerprint && s.fingerprint !== cs.fingerprint) { kept.push({ id: s.id, title: cs.title, why: "stale" }); continue; }
    if (!cs.summary?.deliverable) { kept.push({ id: s.id, title: cs.title, why: "needsYou" }); continue; }
    const r = await deliverChangeSet(v, s.id, { fingerprint: cs.fingerprint ?? undefined });
    if (r.ok) delivered.push({ id: s.id, title: cs.title, applied: r.applied, connected: r.connected ?? 0 });
    else kept.push({ id: s.id, title: cs.title, why: r.conflicts.length ? "needsYou" : (r as { stale?: boolean }).stale ? "stale" : "failed", error: r.error });
  }
  return { delivered, kept };
});
