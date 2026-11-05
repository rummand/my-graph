/**
 * Linear importer (pure): a batch from the Linear connector (one team, one sync window). Issues go into the source's
 * text; the team, its projects you work in, the people on your own open issues, dated project targets and the due
 * dates of your own issues are proposed (the shared work batch, see ../github/work.ts).
 */
import type { Importer } from "../types";
import { detectWork, readWork, workBatch } from "../github/work";

export const linearImporter: Importer = {
  id: "linear",
  label: "Linear issues",
  mime: "application/json",
  json: workBatch,
  detect: (f) => detectWork("linear", f),
  read: (input, ctx) => readWork("linear", input.bytes, ctx),
};
