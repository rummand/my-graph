/**
 * The "plugin" connector type: a connection that runs an installed plugin (see manifest.ts and protocol.ts) as one
 * person, into one graph, like every other connection. Only the platform admin may run one, and only plugins the admin
 * installed in the plugin directory: never anything uploaded.
 *
 * A run: spec → the settings checked against the plugin's own specification (web addresses through the SSRF guard)
 * → discover (the streams and what each becomes) → read with the saved cursors. RECORDs are stored as sources with
 * provenance (url, externalId, connectionId, fetchedAt); each STATE commits the stream's cursor together with the
 * records before it (one transaction), so a crash never moves a cursor past data it didn't store. Event streams are
 * proposed as timeline events (a change set); document streams are read by the library when the connection says so
 * (its proposals are change sets too). Settings marked secret are encrypted with the connection's other secrets and
 * redacted from every log line.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { proposeChanges, type ChangeInput } from "@/lib/changes";
import { needsYou, willRetry } from "@/lib/connectors/errors";
import { defineManifest } from "@/lib/connectors/manifest";
import { checkUrl } from "@/lib/connectors/ssrf";
import { cursorOf } from "@/lib/connectors/state";
import type { Connector, RunContext } from "@/lib/connectors/types";
import * as gbrain from "@/lib/gbrain";
import { reprocessSource } from "@/lib/ingest";
import { isPlatformAdmin } from "@/lib/plans";
import { installedPlugin, type InstalledPlugin } from "./manifest";
import { eventChange, redactAll, sourceFor, stringLeaves } from "./mapping";
import { secretKeys, uriKeys, validateConfig, type ConnectionSpec, type MapKind, type Message, type RecordData } from "./protocol";
import { collect, PluginRunError, runPlugin } from "./runner";

const jsonObject = (what: string) => z.string().max(20_000).default("{}").refine((s) => {
  if (!s.trim()) return true;
  try { const v = JSON.parse(s); return !!v && typeof v === "object" && !Array.isArray(v); } catch { return false; }
}, `${what} are written as a JSON object, such as {"url": "https://…"}.`);

export const pluginConfig = z.object({
  plugin: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Pick an installed plugin by its id."),
  /** The plugin's settings that aren't secret, as JSON. */
  options: jsonObject("Settings"),
  personNodeId: z.uuid().nullish(),
  visibility: z.enum(["private", "parents", "household"]).default("private"),
  /** Have the library read each new document (extracting facts as proposals). Off: just keep them. */
  readDocuments: z.boolean().default(false),
  pluginName: z.string().max(80).optional(),
});
export type PluginConfig = z.infer<typeof pluginConfig>;

export const pluginManifest = defineManifest({
  id: "plugin", version: "1", status: "unofficial", icon: "plug",
  auth: { type: "api_key" },
  config: pluginConfig,
  secrets: z.object({ secretOptions: jsonObject("Secret settings").optional() }),
  fields: [
    { key: "plugin", kind: "text", required: true, placeholder: "rss" },
    { key: "options", kind: "text", placeholder: "{\"url\": \"https://…\"}" },
    { key: "secretOptions", kind: "password", secret: true },
    { key: "personNodeId", kind: "person" },
    { key: "visibility", kind: "visibility" },
    { key: "readDocuments", kind: "boolean" },
  ],
  // The plugin names its own streams (discover); each gets its own cursor under its own name.
  streams: [{ name: "records", key: "key", cursor: "plugin STATE", resetOn: ["reset"] }],
  schedule: { everyMinutes: 60 },
  rateLimit: { perMinute: 60, backoff: "exponential" },
  maps: { records: "document" },
});

const parseObj = (s: string | undefined): Record<string, unknown> => { try { const v = s?.trim() ? JSON.parse(s) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };

function pluginOrThrow(id: string): InstalledPlugin {
  const p = installedPlugin(id);
  if (!p) throw needsYou(`There is no installed plugin called "${id}". The platform admin installs plugins in the plugin directory.`, "pluginMissing");
  return p;
}

/** The plugin's specification, and the settings checked against it (secrets only from the secret settings). */
export async function settingsFor(plugin: InstalledPlugin, options: string, secretOptions: string | undefined, signal?: AbortSignal): Promise<{ spec: ConnectionSpec; config: Record<string, unknown>; redact: (s: string) => string }> {
  const open = parseObj(options), secret = parseObj(secretOptions);
  const hide = stringLeaves(secret);
  const redact = (s: string) => redactAll(s, hide);
  const { messages } = await collect(plugin, "spec", { config: {} }, { signal, redact }).catch((e) => { throw asConnectorError(e); });
  const spec = messages.find((m): m is Extract<Message, { type: "SPEC" }> => m.type === "SPEC")?.spec.connectionSpecification;
  if (!spec) throw needsYou(`The plugin "${plugin.id}" didn't describe its settings (no SPEC).`, "pluginBroken");
  const secrets = secretKeys(spec);
  const misplaced = Object.keys(open).filter((k) => secrets.includes(k));
  if (misplaced.length) throw needsYou(`Put ${misplaced.join(", ")} under the secret settings, not the plain ones.`, "pluginSecretInOptions");
  const v = validateConfig(spec, { ...open, ...secret });
  if (!v.ok) throw needsYou(`A setting needs fixing: ${v.problems.map((p) => `${p.key} ${p.message}`).join("; ")}.`, "pluginSettings");
  // Every web address a plugin will fetch goes through the same SSRF guard as every other connector.
  for (const k of uriKeys(spec)) if (typeof v.config[k] === "string") checkUrl(v.config[k] as string);
  return { spec, config: v.config, redact };
}

function asConnectorError(e: unknown) {
  if (!(e instanceof PluginRunError)) return e;
  if (e.failure === "timeout" || e.failure === "idle" || e.failure === "crashed" || e.failure === "aborted") return willRetry(e.message, "pluginStopped");
  return needsYou(`${e.message} The platform admin needs to look at the plugin.`, "pluginBroken");
}

type Pending = { key: string; data: RecordData };
type Planned = { data: RecordData; sourceId: string; nodeId: string; action: "add" | "update" };

async function flush(ctx: RunContext<PluginConfig>, plugin: InstalledPlugin, stream: string, maps: MapKind, cursor: unknown, pending: Pending[]): Promise<{ planned: Planned[]; added: string[] }> {
  const planned: Planned[] = [];
  const added: string[] = [];
  const fetchedAt = new Date();
  const values = pending.map((p) => ({ p, v: sourceFor({ pluginId: plugin.id, pluginName: plugin.name, stream, maps, key: p.key, data: p.data, fetchedAt }) }));
  // The same key twice in one batch: the last one wins.
  const byExt = new Map(values.map((x) => [x.v.externalId, x]));
  await ctx.commit(stream, cursor, async (tx) => {
    const ids = [...byExt.keys()];
    const existing = new Map<string, { id: string; meta: Record<string, unknown> }>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await tx.select({ id: sources.id, externalId: sources.externalId, meta: sources.meta }).from(sources)
        .where(and(eq(sources.graphId, ctx.connection.graphId), eq(sources.connectionId, ctx.connection.id), inArray(sources.externalId, ids.slice(i, i + 500))));
      for (const r of rows) if (r.externalId) existing.set(r.externalId, { id: r.id, meta: r.meta ?? {} });
    }
    for (const [ext, { p, v }] of byExt) {
      const prev = existing.get(ext);
      if (prev && prev.meta.fingerprint === v.meta.fingerprint) { ctx.count(stream, "unchanged"); continue; }
      if (!prev) {
        const nodeId = maps === "event" ? randomUUID() : undefined;
        const [row] = await tx.insert(sources).values({
          householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id, kind: "connector",
          title: v.title || "Untitled", mime: v.mime, textContent: v.textContent, meta: { ...v.meta, ...(nodeId ? { nodeId } : {}) },
          status: "ready", visibility: ctx.config.visibility ?? "private", documentDate: v.documentDate, documentDatePrecision: v.documentDatePrecision,
          url: v.url, externalId: ext, connectionId: ctx.connection.id, fetchedAt,
        }).returning({ id: sources.id });
        ctx.count(stream, "added");
        added.push(row.id);
        if (nodeId) planned.push({ data: p.data, sourceId: row.id, nodeId, action: "add" });
      } else {
        const nodeId = typeof prev.meta.nodeId === "string" ? prev.meta.nodeId : maps === "event" ? randomUUID() : undefined;
        await tx.update(sources).set({
          title: v.title || "Untitled", textContent: v.textContent, meta: { ...prev.meta, ...v.meta, ...(nodeId ? { nodeId } : {}) },
          documentDate: v.documentDate, documentDatePrecision: v.documentDatePrecision, url: v.url, fetchedAt,
        }).where(eq(sources.id, prev.id));
        ctx.count(stream, "updated");
        if (nodeId) planned.push({ data: p.data, sourceId: prev.id, nodeId, action: "update" });
      }
    }
  });
  return { planned, added };
}

async function proposeEvents(ctx: RunContext<PluginConfig>, plugin: InstalledPlugin, stream: string, planned: Planned[]) {
  if (!planned.length) return;
  let personNodeId: string | null = null;
  if (ctx.config.personNodeId) {
    const p = await gbrain.getNode(ctx.viewer, ctx.config.personNodeId).catch(() => null);
    personNodeId = p?.type === "person" ? p.id : null;
  }
  const changes: ChangeInput[] = [];
  for (const p of planned) {
    const exists = !!(await gbrain.getNode(ctx.viewer, p.nodeId).catch(() => null));
    changes.push(...(eventChange({ data: p.data, sourceId: p.sourceId, nodeId: p.nodeId, nodeExists: exists, visibility: ctx.config.visibility ?? "private", label: ctx.connection.label, personNodeId }) as ChangeInput[]));
  }
  for (let i = 0; i < changes.length; i += 120) {
    const res = await proposeChanges(ctx.viewer, {
      title: `${planned.length} ${planned.length === 1 ? "date" : "dates"} from ${ctx.connection.label}`,
      description: `Read by the plugin "${plugin.name}". Its text is data, not instructions.`,
      origin: "connector", forUserId: ctx.viewer.id,
      evidence: { runId: ctx.runId, locator: { connectionId: ctx.connection.id, stream, plugin: plugin.id } },
      changes: changes.slice(i, i + 120),
    }).catch((e) => { ctx.log(`Couldn't open a proposal: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (!res) continue;
    ctx.proposed(res.id);
    ctx.count(stream, "proposed", planned.length);
    const ids = planned.map((p) => p.sourceId);
    await db.update(sources).set({ meta: sql`jsonb_set(coalesce(${sources.meta}, '{}'::jsonb), '{changeSetId}', to_jsonb(${res.id}::text))` })
      .where(and(eq(sources.graphId, ctx.connection.graphId), inArray(sources.id, ids)));
  }
}

export async function syncPlugin(ctx: RunContext<PluginConfig>): Promise<void> {
  if (!isPlatformAdmin(ctx.viewer)) throw needsYou("Plugin connections run only for the platform admin.", "pluginAdminOnly");
  const plugin = pluginOrThrow(ctx.config.plugin);
  const { config, redact } = await settingsFor(plugin, ctx.config.options, ctx.secrets.secretOptions, ctx.signal);
  const log = (s: string) => ctx.log(redact(s));

  const disc = await collect(plugin, "discover", { config }, { signal: ctx.signal, redact }).catch((e) => { throw asConnectorError(e); });
  const catalog = disc.messages.find((m): m is Extract<Message, { type: "CATALOG" }> => m.type === "CATALOG")?.catalog;
  if (!catalog) throw needsYou(`The plugin "${plugin.id}" didn't say what it reads (no CATALOG).`, "pluginBroken");
  const mapsOf = new Map(catalog.streams.map((s) => [s.name, s.maps]));
  const state = { streams: Object.fromEntries(catalog.streams.map((s) => [s.name, cursorOf(ctx.state(), s.name) ?? null])) };

  const pending = new Map<string, Pending[]>();
  const cursors = new Map<string, unknown>(Object.entries(state.streams));
  const planned = new Map<string, Planned[]>();
  const added: string[] = [];
  let trace: { message: string; failureType: string } | null = null;
  const commit = async (stream: string, cursor: unknown) => {
    const list = pending.get(stream) ?? [];
    pending.set(stream, []);
    const r = await flush(ctx, plugin, stream, mapsOf.get(stream) ?? "document", cursor, list);
    cursors.set(stream, cursor);
    planned.set(stream, [...(planned.get(stream) ?? []), ...r.planned]);
    added.push(...r.added);
  };

  try {
    const it = runPlugin(plugin, "read", { config, catalog, state }, { signal: ctx.signal, redact });
    for await (const m of it) {
      if (m.type === "RECORD") {
        if (!mapsOf.has(m.record.stream)) { log(`Skipped a record from "${m.record.stream}", a stream the plugin didn't list.`); continue; }
        ctx.count(m.record.stream, "fetched");
        const list = pending.get(m.record.stream) ?? [];
        list.push({ key: m.record.key, data: m.record.data });
        pending.set(m.record.stream, list);
        // Very long runs without a STATE still store what came, in batches (the cursor stays where it was).
        if (list.length >= 500) await commit(m.record.stream, cursors.get(m.record.stream) ?? null);
      } else if (m.type === "STATE") {
        if (!mapsOf.has(m.state.stream)) continue;
        await commit(m.state.stream, m.state.cursor);
      } else if (m.type === "LOG") {
        if (m.log.level !== "debug") log(`${m.log.level === "info" ? "" : `${m.log.level}: `}${m.log.message}`.slice(0, 300));
      } else if (m.type === "TRACE") {
        trace = m.trace.error;
        log(`The plugin reported: ${m.trace.error.message}`);
      }
    }
  } catch (e) {
    // A plugin that reported why (TRACE) and then exited non-zero: its reason decides, not the exit code.
    if (!trace) throw asConnectorError(e);
  } finally {
    // What arrived after the last STATE is kept too, with the cursor left where the last STATE put it.
    for (const [stream, list] of pending) if (list.length) await commit(stream, cursors.get(stream) ?? null).catch((err) => log(`Couldn't store the last records: ${err instanceof Error ? err.message : String(err)}`));
  }

  for (const [stream, list] of planned) if (mapsOf.get(stream) === "event") await proposeEvents(ctx, plugin, stream, list);
  if (ctx.config.readDocuments) {
    for (const id of added.slice(0, 200)) await reprocessSource(ctx.viewer, id).catch((e) => log(`Couldn't queue a document for reading: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (trace) {
    const t = trace as { message: string; failureType: string };
    if (t.failureType === "config_error") throw needsYou(redact(t.message), "pluginSettings");
    throw willRetry(redact(t.message), "pluginStopped");
  }
}

export const pluginConnector: Connector<PluginConfig> = {
  manifest: pluginManifest,
  async check(config, secrets) {
    const plugin = pluginOrThrow(config.plugin);
    const { config: settings, redact } = await settingsFor(plugin, config.options, secrets.secretOptions);
    const { messages } = await collect(plugin, "check", { config: settings }, { redact }).catch((e) => { throw asConnectorError(e); });
    const status = messages.find((m): m is Extract<Message, { type: "CONNECTION_STATUS" }> => m.type === "CONNECTION_STATUS")?.connectionStatus;
    if (!status) throw needsYou(`The plugin "${plugin.id}" didn't answer the check.`, "pluginBroken");
    if (status.status !== "SUCCEEDED") throw needsYou(redact(status.message ?? "The plugin couldn't connect with these settings."), "pluginCheckFailed");
  },
  describe(config) {
    const p = installedPlugin(config.plugin);
    return p ? { pluginName: p.name } : {};
  },
  sync: (ctx) => syncPlugin(ctx),
};
