/** Fetch helper for the clinical screens: JSON in, `{ data }` or `{ error }` out (errors come translated from the server). */
export async function call<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown; form?: FormData } = {}, offline = "Couldn't reach My Graph."): Promise<{ data?: T; error?: string; code?: string }> {
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
      headers: init.form ? undefined : init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (data as { error?: string }).error ?? offline, code: (data as { code?: string }).code };
    return { data: data as T };
  } catch {
    return { error: offline };
  }
}
