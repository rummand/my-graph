import { z } from "zod";
import { GraphError } from "@/lib/graphs";
import { parseJson, route } from "@/lib/graphs/http";
import { canAddMemory, memoryAllowed } from "@/lib/memory";
import { KeeperBusyError, keeperStatus, runKeeper } from "@/lib/keeper";

export const dynamic = "force-dynamic";

/** GET: the Brain Keeper's recent runs for me in my current graph (only my own), and whether one is going. */
export const GET = route(async (_req, v) => {
  if (!memoryAllowed(v)) throw new GraphError(403, "Memory is for parents. Ask a parent if something should be remembered.");
  return keeperStatus(v);
});

const body = z.object({ action: z.literal("run", { message: "Send { action: \"run\" }." }) });

/** POST { action: "run" }: Run now. Starts in the background; poll GET for the report. */
export const POST = route(async (req, v) => {
  if (!canAddMemory(v)) throw new GraphError(403, "You can look at what's remembered in this graph but not change it.");
  await parseJson(req, body);
  const status = await keeperStatus(v);
  if (status.busy) throw new GraphError(409, "The Brain Keeper is already running. Its report shows up here when it finishes.");
  void runKeeper(v, "person").catch((e) => { if (!(e instanceof KeeperBusyError)) console.error("[keeper] run now failed:", e); });
  return Response.json({ ok: true, started: true }, { status: 202 });
});
