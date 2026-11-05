import { z } from "zod";
import { audit } from "@/lib/auth";
import { canDecideModel } from "@/lib/meta/emergent";
import { hideRole, roleInput, saveRole, showRole } from "@/lib/meta/role-admin";
import { ApiError, handle, jsonBody } from "@/lib/meta/http";

const input = z.union([
  z.object({ action: z.literal("hide"), key: z.string().trim().min(1).max(48) }),
  z.object({ action: z.literal("show"), key: z.string().trim().min(1).max(48) }),
  z.object({ action: z.literal("save"), role: roleInput }),
]);

/** POST /api/meta/roles { action: save, role } | { action: hide | show, key } — people who decide about the model. */
export const POST = handle(async (req, v) => {
  if (!canDecideModel(v)) throw new ApiError(403, "Only people who can change this graph decide about its model.");
  const body = await jsonBody(req, input);
  if (body.action === "save") {
    const row = await saveRole(v, body.role);
    void audit(v, "meta.role.save", { type: "roles", id: row.id }, { key: row.key }).catch(() => {});
    return { ok: true, key: row.key };
  }
  const ok = body.action === "hide" ? await hideRole(v, body.key) : await showRole(v, body.key);
  if (!ok) throw new ApiError(404, "There's no role with that key.");
  void audit(v, `meta.role.${body.action}`, { type: "roles", id: body.key }, {}).catch(() => {});
  return { ok: true };
});
