/**
 * The My Graph connector plugin protocol, version 1 (pure, no I/O). After Airbyte and Singer: a plugin is a program
 * that is run with one command (`spec`, `check`, `discover` or `read`), reads ONE JSON line on stdin
 * ({ config, catalog?, state? }) and writes JSON lines on stdout, one message each:
 *
 *   SPEC               { type, spec: { protocolVersion: 1, name, version, connectionSpecification, documentationUrl? } }
 *   CONNECTION_STATUS  { type, connectionStatus: { status: "SUCCEEDED" | "FAILED", message? } }
 *   CATALOG            { type, catalog: { streams: [{ name, maps: "document" | "event" | "note", description? }] } }
 *   RECORD             { type, record: { stream, key, data: { title, text?, url?, date?, start?, end?, allDay?, location?, mime?, author? } } }
 *   STATE              { type, state: { stream, cursor } }      the cursor after every RECORD before it in that stream
 *   LOG                { type, log: { level: "debug" | "info" | "warn" | "error", message } }
 *   TRACE              { type, trace: { type: "error", error: { message, failureType: "config_error" | "transient_error" | "system_error" } } }
 *
 * Anything else on stdout is a protocol error; stderr is kept (capped) as the run's log. See docs/plugins/README.md.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const COMMANDS = ["spec", "check", "discover", "read"] as const;
export type Command = (typeof COMMANDS)[number];
export const MAP_KINDS = ["document", "event", "note"] as const;
export type MapKind = (typeof MAP_KINDS)[number];

/** A JSON Schema subset for a plugin's settings: an object of strings, numbers, booleans and string lists. */
const propertySchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  title: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  format: z.enum(["uri", "email", "date"]).optional(),
  /** Encrypted at rest, never shown again, redacted from logs (Airbyte's airbyte_secret). */
  secret: z.boolean().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.string()).max(50).optional(),
  items: z.object({ type: z.literal("string") }).optional(),
  minimum: z.number().optional(), maximum: z.number().optional(), maxLength: z.number().int().positive().optional(),
}).passthrough();
export const connectionSpecSchema = z.object({
  type: z.literal("object"),
  required: z.array(z.string()).default([]),
  properties: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), propertySchema),
  additionalProperties: z.boolean().optional(),
}).passthrough();
export type ConnectionSpec = z.infer<typeof connectionSpecSchema>;

const STREAM = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a stream name is lower-case letters, digits and _");
const isoish = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "not a date");

export const recordDataSchema = z.object({
  title: z.string().min(1).max(500),
  text: z.string().max(200_000).optional(),
  url: z.string().max(2000).optional(),
  /** When the item itself is dated (published, sent, taken). */
  date: isoish.optional(),
  /** Events: when it starts and ends. */
  start: isoish.optional(), end: isoish.optional(), allDay: z.boolean().optional(), location: z.string().max(300).optional(),
  mime: z.string().max(100).optional(), author: z.string().max(200).optional(),
}).passthrough();
export type RecordData = z.infer<typeof recordDataSchema>;

export const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SPEC"), spec: z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), name: z.string().min(1).max(80), version: z.string().max(40), documentationUrl: z.string().max(500).optional(), connectionSpecification: connectionSpecSchema }) }),
  z.object({ type: z.literal("CONNECTION_STATUS"), connectionStatus: z.object({ status: z.enum(["SUCCEEDED", "FAILED"]), message: z.string().max(1000).optional() }) }),
  z.object({ type: z.literal("CATALOG"), catalog: z.object({ streams: z.array(z.object({ name: STREAM, maps: z.enum(MAP_KINDS), description: z.string().max(300).optional() })).min(1).max(20) }) }),
  z.object({ type: z.literal("RECORD"), record: z.object({ stream: STREAM, key: z.string().min(1).max(500), data: recordDataSchema, emittedAt: z.number().optional() }) }),
  z.object({ type: z.literal("STATE"), state: z.object({ stream: STREAM, cursor: z.unknown() }) }),
  z.object({ type: z.literal("LOG"), log: z.object({ level: z.enum(["debug", "info", "warn", "error"]).default("info"), message: z.string().max(4000) }) }),
  z.object({ type: z.literal("TRACE"), trace: z.object({ type: z.literal("error"), error: z.object({ message: z.string().max(2000), failureType: z.enum(["config_error", "transient_error", "system_error"]).default("system_error") }) }) }),
]);
export type Message = z.infer<typeof messageSchema>;
export type MessageOf<T extends Message["type"]> = Extract<Message, { type: T }>;

/** The longest line a plugin may write (a RECORD with a long text fits; a runaway line doesn't). */
export const MAX_LINE = 512 * 1024;

/** One stdout line, read: a message, nothing (a blank line), or why it isn't one. Never throws. */
export function parseLine(line: string): { ok: true; message: Message } | { ok: true; message: null } | { ok: false; error: string } {
  const s = line.trim();
  if (!s) return { ok: true, message: null };
  if (s.length > MAX_LINE) return { ok: false, error: `A line is longer than ${MAX_LINE} characters.` };
  let raw: unknown;
  try { raw = JSON.parse(s); } catch { return { ok: false, error: `Not JSON: ${s.slice(0, 80)}` }; }
  const r = messageSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    const type = raw && typeof raw === "object" && "type" in raw ? String((raw as { type: unknown }).type).slice(0, 30) : "?";
    return { ok: false, error: `A ${type} message doesn't fit the protocol: ${i?.path.join(".") || "message"}: ${i?.message ?? "invalid"}` };
  }
  return { ok: true, message: r.data };
}

/** What the plugin reads on stdin: one JSON line. */
export function inputLine(input: { config: Record<string, unknown>; catalog?: unknown; state?: unknown }): string {
  return `${JSON.stringify(input)}\n`;
}

/* ── Settings against the plugin's own specification ─────────────────────────────────────────────────── */

export type ConfigProblem = { key: string; message: string };

/** Check settings against the spec (the subset above). Returns the problems; applies defaults into a copy. */
export function validateConfig(spec: ConnectionSpec, config: Record<string, unknown>): { ok: true; config: Record<string, unknown> } | { ok: false; problems: ConfigProblem[] } {
  const out: Record<string, unknown> = {};
  const problems: ConfigProblem[] = [];
  for (const [key, p] of Object.entries(spec.properties)) {
    let v = config[key];
    if ((v === undefined || v === "") && p.default !== undefined) v = p.default;
    if (v === undefined || v === "") {
      if (spec.required.includes(key)) problems.push({ key, message: "is needed" });
      continue;
    }
    const bad = (m: string) => problems.push({ key, message: m });
    switch (p.type) {
      case "string":
        if (typeof v !== "string") { bad("is text"); continue; }
        if (p.maxLength && v.length > p.maxLength) { bad(`is at most ${p.maxLength} characters`); continue; }
        if (p.enum && !p.enum.includes(v)) { bad(`is one of ${p.enum.join(", ")}`); continue; }
        if (p.format === "uri") { try { new URL(v); } catch { bad("is a web address"); continue; } }
        break;
      case "number": case "integer": {
        const n = typeof v === "string" ? Number(v) : v;
        if (typeof n !== "number" || !Number.isFinite(n) || (p.type === "integer" && !Number.isInteger(n))) { bad(p.type === "integer" ? "is a whole number" : "is a number"); continue; }
        if (p.minimum !== undefined && n < p.minimum) { bad(`is at least ${p.minimum}`); continue; }
        if (p.maximum !== undefined && n > p.maximum) { bad(`is at most ${p.maximum}`); continue; }
        v = n;
        break;
      }
      case "boolean":
        if (typeof v === "string" && (v === "true" || v === "false")) v = v === "true";
        if (typeof v !== "boolean") { bad("is yes or no"); continue; }
        break;
      case "array":
        if (typeof v === "string") v = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) { bad("is a list"); continue; }
        break;
    }
    out[key] = v;
  }
  if (spec.additionalProperties === false) for (const k of Object.keys(config)) if (!(k in spec.properties)) problems.push({ key: k, message: "isn't a setting of this plugin" });
  return problems.length ? { ok: false, problems } : { ok: true, config: out };
}

/** The keys a spec marks secret: their values are encrypted, redacted from logs and never shown again. */
export const secretKeys = (spec: ConnectionSpec) => Object.entries(spec.properties).filter(([, p]) => p.secret).map(([k]) => k);
/** The keys that are web addresses: each goes through the SSRF guard before the plugin runs. */
export const uriKeys = (spec: ConnectionSpec) => Object.entries(spec.properties).filter(([, p]) => p.type === "string" && p.format === "uri").map(([k]) => k);
