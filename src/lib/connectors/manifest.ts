/**
 * The connector manifest: one typed description per connector (after Airbyte's streams/cursors, Home Assistant's
 * sign-in flow and back-off). Pure, no DB. A connector is mostly this description plus a `sync` function.
 *
 *   id, version, status (official | unofficial | coming_soon), auth type, config (a zod schema for the non-secret
 *   settings), secrets (a zod schema for what is encrypted), fields (how the form shows them), streams (key, cursor,
 *   resetOn), schedule, rateLimit, maps (stream → what it becomes in the graph).
 */
import { z } from "zod";

export const AUTH_TYPES = ["none", "ics_url", "app_password", "oauth2", "api_key", "mitid_session"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const CONNECTOR_STATUSES = ["official", "unofficial", "coming_soon"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** What a stream's items become: a calendar event, an email in a correspondence, a document, a photo. */
export const MAP_TARGETS = ["event", "correspondence", "document", "photo"] as const;
export type MapTarget = (typeof MAP_TARGETS)[number];

export type StreamSpec = {
  name: string;
  /** The field that identifies an item at the source (dedupe key): an ICS UID, a Message-ID. */
  key: string;
  /** What the saved cursor is: an ETag, a UID per folder, a message time. */
  cursor: string;
  /** Provider answers that mean "your cursor is too old": HTTP status codes or names like "uidvalidity". */
  resetOn: (number | string)[];
  sensitivity?: "normal" | "private";
};

/** How the add/edit form shows one setting. `key` is a config key, or a secret key when `secret` is set. */
export type FieldSpec = {
  key: string;
  kind: "text" | "url" | "password" | "number" | "date" | "list" | "person" | "visibility" | "boolean";
  secret?: boolean;
  required?: boolean;
  /** i18n key under connections.fields.<connector>.<key> (label) and ….hint */
  placeholder?: string;
};

export type Manifest<C extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> = {
  id: string;
  version: string;
  status: ConnectorStatus;
  /** Only offered in these graph kinds (Aula is for a family graph). Empty = everywhere. */
  graphKinds?: string[];
  icon: "calendar" | "school" | "mail" | "folder" | "globe";
  auth: { type: AuthType };
  config: C;
  secrets: S;
  fields: FieldSpec[];
  streams: StreamSpec[];
  schedule: { everyMinutes: number };
  rateLimit: { perMinute: number; backoff: "exponential" };
  maps: Record<string, MapTarget>;
};

/** The floor for any schedule: connectors never poll a source more often than every 15 minutes. */
export const MIN_EVERY_MINUTES = 15;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;

const streamSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "A stream name is lower-case letters, digits and _."),
  key: z.string().min(1),
  cursor: z.string().min(1),
  resetOn: z.array(z.union([z.number().int().min(100).max(599), z.string().min(1)])),
  sensitivity: z.enum(["normal", "private"]).optional(),
});

const fieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
  kind: z.enum(["text", "url", "password", "number", "date", "list", "person", "visibility", "boolean"]),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
});

/** The manifest's shape without its zod schemas (those are checked to be zod types separately). */
export const manifestShape = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "A connector id is lower-case letters, digits and _."),
  version: z.string().regex(/^\d+(\.\d+){0,2}$/),
  status: z.enum(CONNECTOR_STATUSES),
  graphKinds: z.array(z.string()).optional(),
  icon: z.enum(["calendar", "school", "mail", "folder", "globe"]),
  auth: z.object({ type: z.enum(AUTH_TYPES) }),
  fields: z.array(fieldSchema),
  streams: z.array(streamSchema),
  schedule: z.object({ everyMinutes: z.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES) }),
  rateLimit: z.object({ perMinute: z.number().int().min(1).max(600), backoff: z.literal("exponential") }),
  maps: z.record(z.string(), z.enum(MAP_TARGETS)),
});

/** Checks a manifest: shape, unique stream names, every stream mapped, every field backed by its schema. */
export function validateManifest(m: Manifest): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const r = manifestShape.safeParse(m);
  if (!r.success) problems.push(...r.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`));
  if (!(m.config instanceof z.ZodType)) problems.push("config: must be a zod schema");
  if (!(m.secrets instanceof z.ZodType)) problems.push("secrets: must be a zod schema");
  const names = new Set<string>();
  for (const s of m.streams ?? []) {
    if (names.has(s.name)) problems.push(`streams: "${s.name}" appears twice`);
    names.add(s.name);
    if (!m.maps?.[s.name]) problems.push(`maps: stream "${s.name}" isn't mapped to anything`);
  }
  for (const k of Object.keys(m.maps ?? {})) if (!names.has(k)) problems.push(`maps: "${k}" is not a stream`);
  if (m.status !== "coming_soon" && (m.streams ?? []).length === 0) problems.push("streams: a working connector reads at least one stream");
  const shapeKeys = (s: unknown) => (s instanceof z.ZodObject ? Object.keys(s.shape) : null);
  const cfgKeys = shapeKeys(m.config), secKeys = shapeKeys(m.secrets);
  for (const f of m.fields ?? []) {
    const keys = f.secret ? secKeys : cfgKeys;
    if (keys && !keys.includes(f.key)) problems.push(`fields: "${f.key}" is not in the ${f.secret ? "secrets" : "config"} schema`);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** Define a connector manifest; throws at import time when it is malformed (caught by the registry test). */
export function defineManifest<C extends z.ZodType, S extends z.ZodType>(m: Manifest<C, S>): Manifest<C, S> {
  const r = validateManifest(m as unknown as Manifest);
  if (!r.ok) throw new Error(`Connector manifest "${m.id}" is invalid: ${r.problems.join("; ")}`);
  return m;
}

/** A schedule a person may pick, clamped to the connector's floor (never under 15 minutes). */
export function clampEvery(minutes: number | undefined, m: Pick<Manifest, "schedule">): number {
  const n = Math.round(Number.isFinite(minutes) ? (minutes as number) : m.schedule.everyMinutes);
  return Math.min(MAX_EVERY_MINUTES, Math.max(MIN_EVERY_MINUTES, n));
}
