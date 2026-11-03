/** Password hashing (bcryptjs, cost 12) and the rules a new password has to meet. */
import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;
export const MIN_PASSWORD = 10;
/** bcrypt only reads the first 72 bytes. */
export const MAX_PASSWORD_BYTES = 72;

/** A precomputed hash to compare against when the account doesn't exist, so timing doesn't reveal it. */
const DUMMY_HASH = "$2b$12$xIXB2vKgQ3meTkrwjpoVwuyN5.EW9OgXC1JmBDbWckTbrdG6KFxT.";

export function passwordProblem(pw: string, context: { email?: string; name?: string } = {}): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (Buffer.byteLength(pw, "utf8") > MAX_PASSWORD_BYTES) return "That password is too long. Keep it under 72 characters.";
  if (/^(.)\1+$/.test(pw)) return "Use more than one repeated character.";
  const lower = pw.toLowerCase();
  if (context.email && lower === context.email.toLowerCase()) return "Don't use your email address as your password.";
  if (context.name && lower === context.name.toLowerCase()) return "Don't use your name as your password.";
  if (["password12", "password123", "1234567890", "qwertyuiop", "mygraph123"].includes(lower)) return "That password is too easy to guess.";
  return null;
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_COST);
}

/** Constant-ish time: always runs one bcrypt compare, even without a stored hash. */
export async function verifyPassword(pw: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(pw, hash ?? DUMMY_HASH);
  return !!hash && ok;
}
