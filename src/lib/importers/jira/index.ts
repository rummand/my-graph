/**
 * Jira importer (pure): a batch from the Jira Cloud connector (one project, one sync window). Issues go into the
 * source's text; the project, the people on your own open issues, released and dated versions, decisions and the due
 * dates of your own issues are proposed (the shared work batch, see ../github/work.ts).
 */
import type { Importer } from "../types";
import { detectWork, readWork, workBatch } from "../github/work";

export const jiraImporter: Importer = {
  id: "jira",
  label: "Jira issues",
  mime: "application/json",
  json: workBatch,
  detect: (f) => detectWork("jira", f),
  read: (input, ctx) => readWork("jira", input.bytes, ctx),
};
