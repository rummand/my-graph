/** Browser-side helpers for the auth forms. */
export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  constructor(message: string, public status: number, public fields: FieldErrors = {}, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

/** fetch JSON with { error, fields } turned into an ApiError. */
export async function api<T = Record<string, unknown>>(url: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers: init.json === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("We couldn't reach My Graph. Check your connection and try again.", 0);
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const fields: FieldErrors = {};
    if (Array.isArray(data.fields)) {
      for (const f of data.fields as { key?: string; message?: string }[]) if (f.key && f.message && !fields[f.key]) fields[f.key] = f.message;
    }
    throw new ApiError(typeof data.error === "string" ? data.error : `Something went wrong (${res.status}).`, res.status, fields, data);
  }
  return data as T;
}

export function errorFields(e: unknown): FieldErrors {
  return e instanceof ApiError ? e.fields : {};
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
