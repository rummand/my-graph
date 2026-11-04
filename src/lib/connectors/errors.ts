/**
 * The two kinds of connector error (after Home Assistant): "needs you" (sign in again, the link was removed, the
 * password changed: nothing happens until a person acts) and "will retry" (network, the server is busy: back off and
 * try again). A third, CursorExpired, isn't shown to anyone: it sends the stream down the one reset path.
 * Messages are plain English for the run log; the UI shows the i18n `code` when it has one.
 */
export type ErrorKind = "needs_you" | "retry";

export class ConnectorError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly code?: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const needsYou = (message: string, code?: string) => new ConnectorError("needs_you", message, code);
export const willRetry = (message: string, code?: string) => new ConnectorError("retry", message, code);

/** The provider says the saved cursor is too old (HTTP 410, IMAP UIDVALIDITY changed): re-read from scratch. */
export class CursorExpired extends Error {
  constructor(readonly stream: string, readonly reason: string | number) {
    super(`The saved position for "${stream}" is no longer valid (${reason}).`);
    this.name = "CursorExpired";
  }
}

/** Sort any thrown thing into needs_you / retry. Unknown errors retry (with back-off), they never stop a connection. */
export function classify(e: unknown): { kind: ErrorKind; message: string; code?: string } {
  if (e instanceof ConnectorError) return { kind: e.kind, message: e.message, code: e.code };
  const err = e as { name?: string; code?: string; message?: string; authenticationFailed?: boolean; responseText?: string };
  if (err?.authenticationFailed) return { kind: "needs_you", message: "The mail server refused the user name or app password.", code: "authFailed" };
  if (err?.name === "AbortError" || err?.code === "ETIMEDOUT") return { kind: "retry", message: "The source took too long to answer.", code: "timeout" };
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") return { kind: "retry", message: "The server's name couldn't be found right now.", code: "dns" };
  if (err?.code === "ECONNREFUSED" || err?.code === "ECONNRESET" || err?.code === "EHOSTUNREACH") return { kind: "retry", message: "Couldn't reach the server.", code: "network" };
  const msg = (err?.message ?? String(e)).slice(0, 300);
  return { kind: "retry", message: msg || "Something went wrong." };
}

/** What an HTTP status from a source means for us. */
export function httpError(status: number, what = "The calendar link"): ConnectorError {
  if (status === 401 || status === 403) return needsYou(`${what} now asks for a sign-in (HTTP ${status}). Paste a fresh link.`, "linkRefused");
  if (status === 404 || status === 410) return needsYou(`${what} no longer exists (HTTP ${status}). It may have been reset; paste the new one.`, "linkGone");
  if (status === 429) return willRetry("The source asked us to slow down.", "rateLimited");
  if (status >= 500) return willRetry(`The source had a problem (HTTP ${status}).`, "serverError");
  return needsYou(`${what} answered with HTTP ${status}.`, "httpOther");
}
