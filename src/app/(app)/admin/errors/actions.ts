"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditAdmin, requirePlatformAdmin } from "@/lib/plans/admin";
import { setErrorResolved } from "@/lib/observability/store";

const input = z.object({ id: z.uuid(), resolved: z.enum(["1", "0"]) });

/**
 * Mark an error group resolved, or open it again. Platform admins only (404 for anyone else); server actions are
 * same-origin only (Next checks Origin against Host), and every change goes to the admin log.
 */
export async function setResolved(form: FormData): Promise<void> {
  const admin = await requirePlatformAdmin();
  const parsed = input.safeParse({ id: form.get("id"), resolved: form.get("resolved") });
  if (!parsed.success) return;
  const resolved = parsed.data.resolved === "1";
  const ok = await setErrorResolved(parsed.data.id, resolved);
  if (ok) await auditAdmin(admin, resolved ? "admin.error.resolve" : "admin.error.reopen", { type: "server_error", id: parsed.data.id });
  revalidatePath("/admin/errors");
}
