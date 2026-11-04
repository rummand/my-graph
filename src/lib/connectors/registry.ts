/**
 * Every connector My Graph knows. Connectors live in the repo (no outside plugin code); adding one is a manifest plus a
 * sync function. Aula messages is unofficial (a MitID sign-in through the Connect Aula helper; see aula/connector.ts).
 */
import type { Manifest } from "./manifest";
import { aulaConnector } from "./aula/connector";
import { aulaCalendarConnector, icsConnector } from "./ics/connector";
import { imapConnector } from "./imap/connector";
import { dropboxConnector } from "./dropbox";
import { gmailConnector, googleCalendarConnector, googleDriveConnector } from "./google";
import { microsoftConnector } from "./microsoft";
import { mcpConnector } from "./mcp/connector";
import { recordConnector } from "./record/connector";
import { pluginConnector } from "@/lib/plugins/connector";
import type { Connector } from "./types";

export { aulaManifest } from "./aula/connector";

/** In the order the gallery shows them. */
export const CONNECTORS: Connector[] = [
  aulaCalendarConnector as unknown as Connector,
  aulaConnector as unknown as Connector,
  recordConnector as unknown as Connector,
  imapConnector as unknown as Connector,
  // Sign in with the household's own Google / Microsoft / Dropbox app (see src/lib/connectors/oauth).
  gmailConnector as unknown as Connector,
  googleCalendarConnector as unknown as Connector,
  googleDriveConnector as unknown as Connector,
  microsoftConnector as unknown as Connector,
  dropboxConnector as unknown as Connector,
  icsConnector as unknown as Connector,
  mcpConnector as unknown as Connector,
  // Runs a plugin the platform admin installed in MG_PLUGINS_DIR (see src/lib/plugins). Offered to the admin only.
  pluginConnector as unknown as Connector,
];

/** Connectors only the platform admin is offered (and may create). */
export const ADMIN_ONLY = new Set(["plugin"]);

/** Connectors that talk MCP (their config is McpConfig and they sign in with a key or OAuth). */
export const MCP_CONNECTORS = new Set(["mcp", "record"]);

export function connectorById(id: string): Connector | null {
  return CONNECTORS.find((c) => c.manifest.id === id) ?? null;
}

/** Which connectors to offer in a graph of this kind (admin-only ones only when `admin`). */
export function offeredIn(graphKind: string, admin = false): Connector[] {
  return CONNECTORS.filter((c) => (admin || !ADMIN_ONLY.has(c.manifest.id))
    && (!c.manifest.graphKinds?.length || c.manifest.graphKinds.includes(graphKind)));
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
