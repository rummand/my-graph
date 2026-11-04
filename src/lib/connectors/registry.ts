/**
 * Every connector My Graph knows. Connectors live in the repo (no outside plugin code); adding one is a manifest plus a
 * sync function. Aula messages are listed as coming soon, with the proposal's explanation of why and how.
 */
import { z } from "zod";
import { defineManifest, type Manifest } from "./manifest";
import { aulaCalendarConnector, icsConnector } from "./ics/connector";
import { imapConnector } from "./imap/connector";
import { mcpConnector } from "./mcp/connector";
import { recordConnector } from "./record/connector";
import type { Connector } from "./types";

export const aulaManifest = defineManifest({
  id: "aula", version: "0", status: "coming_soon", icon: "school", graphKinds: ["family"],
  auth: { type: "mitid_session" },
  config: z.object({}),
  secrets: z.object({}),
  fields: [],
  streams: [
    { name: "threads", key: "id", cursor: "latestMessageAt", resetOn: [410] },
    { name: "calendar", key: "id", cursor: "window", resetOn: [410] },
    { name: "gallery", key: "id", cursor: "albumUpdatedAt", resetOn: [410], sensitivity: "private" },
  ],
  schedule: { everyMinutes: 15 },
  rateLimit: { perMinute: 20, backoff: "exponential" },
  maps: { threads: "correspondence", calendar: "event", gallery: "photo" },
});

const aulaConnector: Connector = { manifest: aulaManifest };

/** In the order the gallery shows them. */
export const CONNECTORS: Connector[] = [
  aulaCalendarConnector as unknown as Connector,
  recordConnector as unknown as Connector,
  imapConnector as unknown as Connector,
  icsConnector as unknown as Connector,
  mcpConnector as unknown as Connector,
  aulaConnector,
];

/** Connectors that talk MCP (their config is McpConfig and they sign in with a key or OAuth). */
export const MCP_CONNECTORS = new Set(["mcp", "record"]);

export function connectorById(id: string): Connector | null {
  return CONNECTORS.find((c) => c.manifest.id === id) ?? null;
}

/** Which connectors to offer in a graph of this kind. */
export function offeredIn(graphKind: string): Connector[] {
  return CONNECTORS.filter((c) => !c.manifest.graphKinds?.length || c.manifest.graphKinds.includes(graphKind));
}

/** A manifest as the browser sees it: no zod schemas, just what the form and gallery need. */
export type ConnectorInfo = Pick<Manifest, "id" | "version" | "status" | "icon" | "fields" | "schedule"> & {
  authType: Manifest["auth"]["type"]; streams: string[]; maps: string[];
};

export function connectorInfo(c: Connector): ConnectorInfo {
  const m = c.manifest;
  return {
    id: m.id, version: m.version, status: m.status, icon: m.icon, fields: m.fields, schedule: m.schedule,
    authType: m.auth.type, streams: m.streams.map((s) => s.name), maps: [...new Set(Object.values(m.maps))],
  };
}
