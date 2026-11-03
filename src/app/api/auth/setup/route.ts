import type { NextRequest } from "next/server";
import { audit } from "@/lib/auth";
import { errorJson, handle, parseBody } from "@/lib/auth/http";
import { createHouseholdWithOwner } from "@/lib/auth/members";
import { hashPassword, passwordProblem } from "@/lib/auth/passwords";
import { setupBody } from "@/lib/auth/schemas";
import { completeSignIn, findUserById } from "@/lib/auth/signin";

/** POST: first run only — creates the household and its owner, then signs the owner in. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = await parseBody(req, setupBody);
    const problem = passwordProblem(body.password, { email: body.email, name: body.name });
    if (problem) return errorJson(400, problem, { fields: [{ key: "password", message: problem }] });
    const created = await createHouseholdWithOwner({
      householdName: body.householdName, name: body.name, email: body.email, passwordHash: await hashPassword(body.password),
    });
    if (!created) return errorJson(409, "My Graph is already set up. Sign in instead.");
    const owner = await findUserById(created.userId);
    if (!owner) return errorJson(500, "Setup didn't finish. Please try again.");
    await audit(owner, "setup.complete", { type: "household", id: created.householdId }, { householdName: body.householdName });
    return completeSignIn(req, owner, "setup");
  });
}
