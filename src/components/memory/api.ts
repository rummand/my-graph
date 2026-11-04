/** Browser calls to /api/memory. Every one returns the error text from the server when it fails. */
import type { MemoryView } from "@/lib/memory/types";
import type { MemoryKind, MemoryVisibility } from "@/lib/memory/pure";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "That didn't go through. Try again.");
  return body as T;
}

export const memoryApi = {
  list: (params: { about?: string; status?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => !!v) as [string, string][]);
    return call<{ memories: MemoryView[] }>(`/api/memory?${qs}`).then((r) => r.memories);
  },
  add: (input: { kind: MemoryKind; text: string; aboutNodeIds: string[]; visibility: MemoryVisibility }) =>
    call<{ memory: MemoryView }>("/api/memory", { method: "POST", body: JSON.stringify(input) }).then((r) => r.memory),
  update: (id: string, patch: Partial<{ text: string; kind: MemoryKind; status: "active" | "paused"; aboutNodeIds: string[]; visibility: MemoryVisibility }>) =>
    call<{ memory: MemoryView }>(`/api/memory/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then((r) => r.memory),
  remove: (id: string, keepalive = false) => call<{ ok: true }>(`/api/memory/${id}`, { method: "DELETE", keepalive }),
};
