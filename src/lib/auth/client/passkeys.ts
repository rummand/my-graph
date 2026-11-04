/** Browser WebAuthn calls (via @simplewebauthn/browser v13). */
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";

export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

/** A browser-side passkey failure; `code` picks the translated message (auth.login.passkeyErrors.*). */
export class PasskeyError extends Error {
  constructor(readonly code: "cancelled" | "alreadyRegistered" | "failed", message: string) { super(message); this.name = "PasskeyError"; }
}

// Raw browser errors are technical and English ("Resident credentials or empty 'allowCredentials' lists are not
// supported…"), so only server answers pass through; everything else becomes one of three plain messages.
function friendly(e: unknown): Error {
  if (e instanceof ApiError) return e;
  if (e instanceof WebAuthnError) {
    if (e.code === "ERROR_CEREMONY_ABORTED") return new PasskeyError("cancelled", "The passkey request was cancelled or timed out.");
    if (e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return new PasskeyError("alreadyRegistered", "This device already has a passkey for your account.");
  }
  if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) return new PasskeyError("cancelled", "The passkey request was cancelled or timed out.");
  return new PasskeyError("failed", "The passkey didn't work on this device. Try again, or use your password.");
}

export async function signInWithPasskey(): Promise<{ pending: boolean }> {
  try {
    const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
      "/api/auth/passkey/login/options", { method: "POST" });
    const response = await startAuthentication({ optionsJSON: options });
    return await api<{ pending: boolean }>("/api/auth/passkey/login/verify", { json: { challengeId, response } });
  } catch (e) {
    throw friendly(e);
  }
}

export async function addPasskey(name: string): Promise<void> {
  try {
    const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
      "/api/auth/passkey/register/options", { method: "POST" });
    const response = await startRegistration({ optionsJSON: options });
    await api("/api/auth/passkey/register/verify", { json: { challengeId, response, name } });
  } catch (e) {
    throw friendly(e);
  }
}

/** A default name for a new passkey, from the browser ("Mac", "iPhone" …). */
export function guessDeviceName(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "Passkey";
}
