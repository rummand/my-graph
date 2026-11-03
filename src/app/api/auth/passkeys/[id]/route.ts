import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { passkeys, users } from "@/db/schema";
import { audit, requireUserApi } from "@/lib/auth";
import { AuthError, handle, parseBody, parseParams } from "@/lib/auth/http";
import { idParam, passkeyRenameBody } from "@/lib/auth/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH { name }: rename one of your passkeys. */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireUserApi();
    const { id } = parseParams(await ctx.params, idParam);
    const body = await parseBody(req, passkeyRenameBody);
    const [row] = await db.update(passkeys).set({ name: body.name }).where(and(eq(passkeys.id, id), eq(passkeys.userId, v.id)))
      .returning({ id: passkeys.id, name: passkeys.name });
    if (!row) throw new AuthError(404, "That passkey wasn't found.");
    await audit(v, "passkey.rename", { type: "passkey", id }, { name: body.name });
    return Response.json({ passkey: row });
  });
}

/** DELETE: remove one of your passkeys. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireUserApi();
    const { id } = parseParams(await ctx.params, idParam);
    const [me] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, v.id));
    const mine = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, v.id));
    if (!me?.hash && mine.length <= 1 && mine.some((p) => p.id === id)) {
      throw new AuthError(409, "This is your only way to sign in. Set a password first, then remove the passkey.");
    }
    const [row] = await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, v.id))).returning({ id: passkeys.id, name: passkeys.name });
    if (!row) throw new AuthError(404, "That passkey wasn't found.");
    await audit(v, "passkey.remove", { type: "passkey", id }, { name: row.name });
    return Response.json({ ok: true });
  });
}
