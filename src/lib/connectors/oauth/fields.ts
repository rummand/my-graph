/** Settings and small rules every provider connector shares (pure). */
import { z } from "zod";
import { needsYou } from "../errors";

/** Who may see what it brings in. */
export const visibility = z.enum(["private", "parents", "household"]).default("private");
/** Filled in after the sign-in: who signed in, for showing ("anna@gmail.com"). */
export const account = z.string().max(320).optional();
export const sinceField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date.").optional();
/** The token lives here, encrypted, and is written only by the sign-in (never typed into a form). */
export const oauthSecrets = z.object({ oauth: z.string().max(20_000).optional() });

/** The day reading starts from: the chosen date, else 90 days back. */
export function sinceDay(since: string | undefined, now: Date): Date {
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) return new Date(`${since}T00:00:00Z`);
  return new Date(now.getTime() - 90 * 86_400_000);
}

/** Every provider connector refuses to be made without signing in (the form's Sign in button makes it instead). */
export function requireSignIn(secrets: Record<string, string>): void {
  if (!secrets.oauth) throw needsYou("Use the Sign in button to connect it.", "signIn");
}
