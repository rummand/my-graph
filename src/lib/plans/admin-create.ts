/**
 * New accounts made by a platform admin from the console (there is no public sign-up). The person gets a household of
 * their own (they own it) and a first graph: Family (the household's graph, like first-run setup) or Personal (like
 * someone who joins through an invite). No password is set here: the admin hands over a one-time link or a temporary
 * password afterwards. Server-only.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { households } from "@/db/schema";
import { AuthError } from "@/lib/auth/http";
import { createAccount, emailTaken } from "@/lib/auth/members";
import { personName } from "@/lib/auth/schemas";
import { createAccountWithOwnHousehold } from "@/lib/graphs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const newAccountBody = z.object({
  name: personName,
  email: z.string().trim().toLowerCase().regex(EMAIL, "Enter a valid email address.").max(254, "That is too long."),
  householdName: z.string().trim().max(80, "Keep the household name under 80 characters.").optional(),
  firstGraph: z.enum(["family", "personal"]).default("family"),
  plan: z.string().min(1).max(40).optional(),
  access: z.enum(["link", "temp"]).default("link"),
});
export type NewAccountInput = z.infer<typeof newAccountBody>;

/** The household's name when the admin leaves it empty. */
export function defaultHouseholdName(name: string): string {
  return `${name.trim()}'s home`;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/** Create the account, its household and first graph in one transaction. 409 if the email is taken or reserved. */
export async function createAccountByAdmin(input: Pick<NewAccountInput, "name" | "email" | "householdName" | "firstGraph">):
  Promise<{ userId: string; householdId: string }> {
  if (await emailTaken(input.email)) throw new AuthError(409, "An account with this email already exists.");
  try {
    return await db.transaction(async (tx) => {
      if (input.firstGraph === "personal") {
        const acct = await createAccountWithOwnHousehold(tx, { name: input.name, email: input.email, passwordHash: null });
        if (input.householdName) await tx.update(households).set({ name: input.householdName }).where(eq(households.id, acct.householdId));
        return { userId: acct.userId, householdId: acct.householdId };
      }
      const [h] = await tx.insert(households).values({ name: input.householdName || defaultHouseholdName(input.name) })
        .returning({ id: households.id });
      const acct = await createAccount(tx, { householdId: h.id, role: "owner", name: input.name, email: input.email, passwordHash: null }, null);
      return { userId: acct.userId, householdId: h.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AuthError(409, "An account with this email already exists.");
    throw e;
  }
}
