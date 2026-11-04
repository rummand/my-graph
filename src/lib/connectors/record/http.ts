/** Route plumbing for /api/recordings: the viewer, zod parsing, JSON { error } with proper statuses. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { AudioUnavailable } from "./recordings";

export class RecordingsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const sourceIdParam = z.object({ sourceId: z.uuid() });

export function recordingsRoute<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof RecordingsError || e instanceof AudioUnavailable) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof z.ZodError) return NextResponse.json({ error: e.issues[0]?.message ?? "That request isn't valid." }, { status: 400 });
      console.error("[recordings api]", e instanceof Error ? e.message : e);
      return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 });
    }
  };
}

export async function sourceIdOf(params: Promise<unknown>): Promise<string> {
  const r = sourceIdParam.safeParse(await params);
  if (!r.success) throw new RecordingsError(404, "This recording doesn't exist, or you can't see it.");
  return r.data.sourceId;
}
