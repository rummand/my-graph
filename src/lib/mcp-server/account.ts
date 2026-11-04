/**
 * The person's side, signed in to My Graph (server-only): their keys and connected apps, and who may have them.
 * Children and guests don't connect AI apps or make keys (as with Connections).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireUserApi, type Viewer } from "@/lib/auth";
import { graphsOfUser } from "@/lib/graphs/store";
import { KeyError } from "./keys";

export class McpHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export const mayConnectApps = (v: Pick<Viewer, "role">) => v.role !== "guest" && v.role !== "child";

/** A session route for the settings page: the viewer, zod, `{ error }` JSON. */
export function accountRoute<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUserApi();
      if (!mayConnectApps(v)) throw new McpHttpError(403, "AI apps and keys are for the grown-ups in the family.", "notAllowed");
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof McpHttpError || e instanceof KeyError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      if (e instanceof z.ZodError) {
        const i = e.issues[0];
        return NextResponse.json({ error: i ? `${i.path.join(".") || "Request"}: ${i.message}` : "Invalid request." }, { status: 400 });
      }
      console.error("[mcp-server api]", e);
      return NextResponse.json({ error: "Something went wrong on our side. Try again in a moment." }, { status: 500 });
    }
  };
}

export async function jsonBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.length > 20_000) throw new McpHttpError(413, "That request is too large.");
  let raw: unknown = {};
  if (text.trim()) { try { raw = JSON.parse(text); } catch { throw new McpHttpError(400, "The request body isn't valid JSON."); } }
  return schema.parse(raw);
}

/** The graphs a person may pick for a key or an app: live ones they are in, with whether they may write there. */
export async function pickableGraphs(v: Viewer): Promise<{ id: string; name: string; kind: string; canPropose: boolean }[]> {
  const gs = await graphsOfUser(v);
  return gs.map((g) => ({ id: g.id, name: g.name, kind: g.kind, canPropose: g.myRole !== "viewer" && !(g.kind === "family" && v.role === "guest") }));
}

export const createKeyBody = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(60),
  graphId: z.uuid(),
  scope: z.enum(["read", "propose"]).default("read"),
}).strict();

export { audit };
