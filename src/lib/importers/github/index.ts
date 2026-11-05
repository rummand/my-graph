/**
 * GitHub importer (pure): a batch from the GitHub connector (one repository, one sync window). Issues and pull requests
 * go into the source's text; the repository, the people on your own open work, releases, milestones, decisions and
 * your due dates are proposed (see ./work.ts). Structured: the model doesn't read it again.
 */
import type { Importer } from "../types";
import { detectWork, readWork, workBatch } from "./work";

export const githubImporter: Importer = {
  id: "github",
  label: "GitHub issues and pull requests",
  mime: "application/json",
  json: workBatch,
  detect: (f) => detectWork("github", f),
  read: (input, ctx) => readWork("github", input.bytes, ctx),
};
