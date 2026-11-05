/**
 * sundhed.dk: a "how this works" card in the Danish connectors, not a sync. sundhed.dk has no API for citizens.
 *
 * What works today:
 *   - Printouts and PDFs saved from sundhed.dk ("Min sundhedsjournal", "Medicinkortet", "Vaccinationer",
 *     "Laboratoriesvar") uploaded to the library or shared from the iPhone are recognised by the reading pipeline
 *     (src/lib/importers/dk/sundhed.ts): the source is made sensitive and private before anything is embedded or read
 *     (mux only with no-fallback), and its entries become private proposals about the person themself.
 *   - Apple Health records the person chooses to share from the iPhone app arrive at POST /api/import/health (the
 *     `health` importer), with the same rules.
 */
import { z } from "zod";
import { defineManifest } from "../../manifest";
import type { Connector } from "../../types";

export const sundhedManifest = defineManifest({
  id: "sundhed", version: "1", status: "coming_soon", icon: "health", region: "dk",
  graphKinds: ["family", "personal", "partner"],
  auth: { type: "none" },
  config: z.object({}),
  secrets: z.object({}),
  fields: [],
  streams: [],
  schedule: { everyMinutes: 1440 },
  rateLimit: { perMinute: 10, backoff: "exponential" },
  maps: {},
});

export const sundhedConnector: Connector = { manifest: sundhedManifest };
