import { readYou, refreshYou } from "@/lib/you";
import { youRoute } from "@/lib/you/http";

/** POST /api/you/refresh → work the person's own patterns out again now (at most every couple of minutes). */
export const POST = youRoute(async (_req, v) => {
  await refreshYou(v);
  return readYou(v);
});
