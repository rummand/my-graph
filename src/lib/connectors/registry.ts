/**
 * Every connector My Graph knows. Connectors live in the repo (no outside plugin code); adding one is a manifest plus a
 * sync function. Aula messages is unofficial (a MitID sign-in through the Connect Aula helper; see aula/connector.ts).
 */
import type { Manifest } from "./manifest";
import { aulaConnector } from "./dk/aula/connector";
import { aulaCalendarConnector, icsConnector } from "./ics/connector";
import { imapConnector } from "./imap/connector";
import { carddavConnector } from "./carddav/connector";
import { googleContactsConnector } from "./google";
import { dropboxConnector } from "./dropbox";
import { gmailConnector, googleCalendarConnector, googleDriveConnector, googlePhotosConnector } from "./google";
import { microsoftConnector } from "./microsoft";
import { mcpConnector } from "./mcp/connector";
import { recordConnector } from "./record/connector";
import { macConnector } from "./mac/connector";
import { spondConnector } from "./spond/connector";
import { holdsportConnector } from "./dk/holdsport/connector";
import { schoolConnector } from "./dk/minuddannelse/connector";
import { famlyConnector } from "./famly/connector";
import { digitalPostConnector } from "./dk/digital-post/connector";
import { sundhedConnector } from "./dk/sundhed/connector";
import { pluginConnector } from "@/lib/plugins/connector";
import { githubConnector, githubOAuthConnector } from "./github";
import { linearConnector, linearOAuthConnector } from "./linear";
import { jiraConnector } from "./jira";
import { slackConnector } from "./slack";
import { notionConnector } from "./notion";
import { homeAssistantConnector } from "./home_assistant";
import type { Connector } from "./types";

export { aulaManifest } from "./dk/aula/connector";

/** In the order the gallery shows them. */
export const CONNECTORS: Connector[] = [
  aulaCalendarConnector as unknown as Connector,
  aulaConnector as unknown as Connector,
  // Weekly plans and homework through Aula's widgets, with the Aula messages sign-in (dk/minuddannelse).
  schoolConnector as unknown as Connector,
  famlyConnector as unknown as Connector,
  recordConnector as unknown as Connector,
  // Messages and Notes, sent by the helper the person runs on their own Mac (see mac/connector.ts).
  macConnector as unknown as Connector,
  imapConnector as unknown as Connector,
  carddavConnector as unknown as Connector,
  // Sign in with the household's own Google / Microsoft / Dropbox app (see src/lib/connectors/oauth).
  gmailConnector as unknown as Connector,
  googleCalendarConnector as unknown as Connector,
  googleDriveConnector as unknown as Connector,
  googleContactsConnector as unknown as Connector,
  googlePhotosConnector as unknown as Connector,
  microsoftConnector as unknown as Connector,
  dropboxConnector as unknown as Connector,
  icsConnector as unknown as Connector,
  // Work: issues, pull requests and projects (a token first, then the household's own GitHub / Linear app).
  githubConnector as unknown as Connector,
  githubOAuthConnector as unknown as Connector,
  linearConnector as unknown as Connector,
  linearOAuthConnector as unknown as Connector,
  jiraConnector as unknown as Connector,
  // Slack and Notion with the household's own apps (oauth/providers.ts); Home Assistant with the home's own token.
  slackConnector as unknown as Connector,
  notionConnector as unknown as Connector,
  homeAssistantConnector as unknown as Connector,
  spondConnector as unknown as Connector,
  holdsportConnector as unknown as Connector,
  // Danish public post and health: how-this-works cards (read through mail and uploaded PDFs; see dk/digital-post).
  digitalPostConnector, sundhedConnector,
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
export type ConnectorInfo = Pick<Manifest, "id" | "version" | "status" | "icon" | "fields" | "schedule" | "region"> & {
  authType: Manifest["auth"]["type"]; streams: string[]; maps: string[];
};

export function connectorInfo(c: Connector): ConnectorInfo {
  const m = c.manifest;
  return {
    id: m.id, version: m.version, status: m.status, icon: m.icon, fields: m.fields, schedule: m.schedule, region: m.region,
    authType: m.auth.type, streams: m.streams.map((s) => s.name), maps: [...new Set(Object.values(m.maps))],
  };
}
