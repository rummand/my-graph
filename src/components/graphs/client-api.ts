/** Browser-side calls to /api/graphs and /api/invites, with `{ error }` turned into an Error carrying the message. */
export class GraphApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown> = {}) { super(message); }
}

export async function graphApi<T = Record<string, unknown>>(url: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method, credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new GraphApiError("We couldn't reach My Graph. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new GraphApiError(typeof data.error === "string" ? data.error : "That didn't work. Try again.", res.status, data);
  return data as T;
}

export const switchGraph = (graphId: string) => graphApi("/api/graphs/switch", "POST", { graphId });

/** Detail pages (/node/<id>, /artifacts/pages/<slug>, …) belong to one graph; after a switch, go back to their section's list. */
export function pathAfterSwitch(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  // The Artifacts hub's tabs are lists themselves: a page or a style goes back to its own tab.
  if (parts[0] === "artifacts" && ["pages", "documents", "decks", "styles"].includes(parts[1] ?? "")) return parts.length > 2 ? `/artifacts/${parts[1]}` : null;
  if (parts.length > 1 && parts[0] !== "settings" && parts[0] !== "graphs") return `/${parts[0]}`;
  return null;
}
