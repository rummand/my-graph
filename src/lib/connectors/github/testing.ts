/** Test doubles for the work connectors (pure): deps whose importer records the batches it would store. */
import { workBatch, type WorkBatchInput } from "@/lib/importers/github/work";
import type { Api } from "../oauth/client";
import type { WorkDeps } from "./work";

export function recordingDeps(api: Api) {
  const batches: { importer: string; batch: WorkBatchInput; title: string; externalId: string }[] = [];
  const d: WorkDeps = {
    api, base: { github: "https://api.github.com", linear: "https://api.linear.app/graphql" },
    async importBatch(_ctx, importer, batch, o) {
      workBatch.parse(batch); // exactly what the importer will accept
      batches.push({ importer, batch, ...o });
      return { sourceId: `s${batches.length}`, duplicate: false };
    },
  };
  return { d, batches };
}
