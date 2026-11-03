/** Passkeys (WebAuthn) with @simplewebauthn/server v13. Challenges are single-use rows in auth_challenges. */
import { and, eq, gt } from "drizzle-orm";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { db } from "@/db";
import { authChallenges, passkeys } from "@/db/schema";
import { AuthError } from "./http";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/** Relying party from env: WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN, falling back to APP_URL, then localhost. */
export function relyingParty(env: Record<string, string | undefined> = process.env) {
  const rpID = env.WEBAUTHN_RP_ID || hostOf(env.APP_URL) || "localhost";
  const origins = [env.WEBAUTHN_ORIGIN, env.APP_URL].filter((o): o is string => !!o).map((o) => o.replace(/\/$/, ""));
  if (!origins.length) origins.push("http://localhost:3000");
  return { rpID, rpName: "My Graph", origins };
}

/**
 * Origins accepted for this request. In development a request from any port on the RP host is accepted too
 * (so `next dev -p 3101` works with rpID localhost).
 */
export function expectedOrigins(reqOrigin: string | null, env: Record<string, string | undefined> = process.env): string[] {
  const rp = relyingParty(env);
  const list = new Set(rp.origins);
  if (env.NODE_ENV !== "production" && reqOrigin && hostOf(reqOrigin) === rp.rpID) list.add(reqOrigin);
  return [...list];
}

async function saveChallenge(challenge: string, userId: string | null): Promise<string> {
  const [row] = await db.insert(authChallenges).values({ userId, challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) })
    .returning({ id: authChallenges.id });
  return row.id;
}

/** Use a challenge once. Returns null when unknown, expired, or issued for another user. */
async function takeChallenge(id: string, userId: string | null): Promise<string | null> {
  const [row] = await db.delete(authChallenges).where(and(eq(authChallenges.id, id), gt(authChallenges.expiresAt, new Date())))
    .returning({ challenge: authChallenges.challenge, userId: authChallenges.userId });
  if (!row) return null;
  if ((row.userId ?? null) !== userId) return null;
  return row.challenge;
}

const asTransports = (t: string[] | null | undefined) => (t ?? []) as AuthenticatorTransportFuture[];

export async function registrationOptions(user: { id: string; email: string; name: string }) {
  const rp = relyingParty();
  const existing = await db.select({ credentialId: passkeys.credentialId, transports: passkeys.transports }).from(passkeys)
    .where(eq(passkeys.userId, user.id));
  const options = await generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpID, userName: user.email, userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id), attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: asTransports(p.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  const challengeId = await saveChallenge(options.challenge, user.id);
  return { challengeId, options };
}

export async function verifyRegistration(user: { id: string }, challengeId: string, response: unknown, reqOrigin: string | null, name?: string) {
  const challenge = await takeChallenge(challengeId, user.id);
  if (!challenge) throw new AuthError(400, "That passkey request expired. Please try again.");
  const rp = relyingParty();
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(reqOrigin), expectedRPID: rp.rpID, requireUserVerification: false,
    });
  } catch (e) {
    throw new AuthError(400, `We couldn't verify that passkey: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  if (!result.verified) throw new AuthError(400, "We couldn't verify that passkey.");
  const { credential } = result.registrationInfo;
  const [dup] = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credential.id)).limit(1);
  if (dup) throw new AuthError(409, "This passkey is already registered.");
  const [row] = await db.insert(passkeys).values({
    userId: user.id, credentialId: credential.id, publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter, transports: credential.transports ?? [], name: name?.trim() || "Passkey",
  }).returning({ id: passkeys.id, name: passkeys.name });
  return row;
}

export async function authenticationOptions() {
  const rp = relyingParty();
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
  const challengeId = await saveChallenge(options.challenge, null);
  return { challengeId, options };
}

/** Verifies a passkey sign-in and returns the user id it belongs to. */
export async function verifyAuthentication(challengeId: string, response: unknown, reqOrigin: string | null): Promise<{ userId: string; passkeyId: string }> {
  const challenge = await takeChallenge(challengeId, null);
  if (!challenge) throw new AuthError(400, "That sign-in request expired. Please try again.");
  const resp = response as AuthenticationResponseJSON;
  const [pk] = await db.select().from(passkeys).where(eq(passkeys.credentialId, resp.id)).limit(1);
  if (!pk) throw new AuthError(401, "This passkey isn't registered with My Graph. Sign in with your password and add it in Settings.");
  const rp = relyingParty();
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: resp, expectedChallenge: challenge, expectedOrigin: expectedOrigins(reqOrigin), expectedRPID: rp.rpID,
      requireUserVerification: false,
      credential: { id: pk.credentialId, publicKey: isoBase64URL.toBuffer(pk.publicKey), counter: pk.counter, transports: asTransports(pk.transports) },
    });
  } catch (e) {
    throw new AuthError(401, `We couldn't verify that passkey: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  if (!result.verified) throw new AuthError(401, "We couldn't verify that passkey.");
  await db.update(passkeys).set({ counter: result.authenticationInfo.newCounter }).where(eq(passkeys.id, pk.id));
  return { userId: pk.userId, passkeyId: pk.id };
}
