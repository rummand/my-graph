/**
 * A Viewer for background work (automations, check-ins): the person as they would be signed in, working in one
 * graph. Null when the user no longer exists, may not sign in (guest access ended), or is no longer a member of that
 * graph — callers must then skip the work. No Next request APIs are used, so this runs outside a request.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { viewerInGraph } from "@/lib/graphs/store";
import type { Viewer } from "./index";
import { signInBlocked, toViewer } from "./store";

export async function viewerFor(userId: string, graphId: string): Promise<Viewer | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return null;
  if (signInBlocked(u)) return null;
  const v = await viewerInGraph(toViewer(u), graphId);
  return v ?? null;
}
