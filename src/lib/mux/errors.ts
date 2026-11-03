/** Typed mux errors. Callers branch on these to degrade gracefully (no model → keyword search, plain answers). */

export class MuxError extends Error {
  constructor(
    /** HTTP status from mux (0 when mux could not be reached at all). */
    public status: number,
    /** mux's machine-readable error type (`invalid_api_key`, `no_model`, `rate_limited`, …) or our own. */
    public type: string,
    message: string,
    public requestId: string | null = null,
    public retryAfterS?: number,
  ) {
    super(message);
    this.name = "MuxError";
  }
}

/** mux is down, unreachable, timed out, or has no model that can answer right now. */
export class MuxUnavailableError extends MuxError {
  constructor(message = "The model gateway (mux) can't be reached right now.", status = 0, type = "unavailable", requestId: string | null = null) {
    super(status, type, message, requestId);
    this.name = "MuxUnavailableError";
  }
}

/** No API key configured, or mux refused the key. */
export class MuxAuthError extends MuxError {
  constructor(message = "mux refused the API key. Check MUX_API_KEY.", status = 401, type = "invalid_api_key", requestId: string | null = null) {
    super(status, type, message, requestId);
    this.name = "MuxAuthError";
  }
}

export function isMuxDown(e: unknown): e is MuxUnavailableError | MuxAuthError {
  return e instanceof MuxUnavailableError || e instanceof MuxAuthError;
}

/** Map an HTTP error answer from mux (OpenAI error shape `{ error: { message, type, code } }`) to a typed error. */
export function errorFromResponse(status: number, body: unknown, requestId: string | null, retryAfter: string | null): MuxError {
  const err = (body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null) as
    | { message?: unknown; type?: unknown } | string | null;
  const message = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : `mux answered HTTP ${status}`;
  const type = typeof err === "object" && err && typeof err.type === "string" ? err.type : `http_${status}`;
  if (status === 401 || (status === 403 && /key|auth|forbidden|tenant/i.test(type))) {
    return new MuxAuthError(`mux refused the request: ${message}`, status, type, requestId);
  }
  if (status === 502 || status === 503 || status === 504 || status === 529) {
    return new MuxUnavailableError(`No model can answer right now (${message}).`, status, type, requestId);
  }
  const retry = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  return new MuxError(status, type, message, requestId, retry);
}
