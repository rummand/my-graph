/**
 * Home Assistant, read-only, with the home's address and a long-lived access token (Profile, Security, Long-lived
 * access tokens; made by an administrator, since rooms and devices are read with a template render).
 *
 *   home         areas and devices (manufacturer, model, room) → one batch; the `home_assistant` importer proposes the
 *                home, its rooms and its devices. The batch has no versions or live states, so it changes (and is read
 *                again) only when a room or device is added, renamed or moved.
 *   maintenance  low batteries (≤ 20 %) and available updates → reminder proposals, each once while it lasts (the
 *                cursor keeps what was already proposed; a battery that was changed and runs low again is new).
 *   logbook      optional: the logbook of up to 10 chosen entities, one searchable source per day.
 *
 * Where it can reach: the guarded transport allows only public https addresses on the standard port. A home's Home
 * Assistant on the LAN (homeassistant.local, 192.168.x.x, :8123) is refused in production; use its Nabu Casa address
 * (https://….ui.nabu.casa) or the home's own domain behind https. Development reaches this computer (loopback) only.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { needsYou, willRetry } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected, type Api } from "../oauth/client";
import { visibility } from "../oauth/fields";
import type { ImportBatch } from "../slack/connector";
import { HA_GRAPH_KINDS } from "@/lib/importers/home_assistant";
import { ENTITY_ID, HOME_TEMPLATE, homePayload, logbookDays, maintenanceItems, type HaState, type LogbookEntry, type TemplateAnswer } from "./map";

export const haConfig = z.object({
  homeUrl: z.string().trim().min(1, "Paste the address of your Home Assistant.").max(500),
  /** Entities whose logbook is kept (light.kitchen, lock.front_door …). Empty: no logbook. */
  logbookEntities: z.array(z.string().trim().toLowerCase().regex(ENTITY_ID, "An entity id looks like lock.front_door.")).max(10).default([]),
  /** Propose reminders for low batteries and available updates. */
  maintenance: z.boolean().default(true),
  visibility,
  /** Filled in when the connection is made: the host, for showing. */
  feedHost: z.string().max(300).optional(),
});
export type HaConfig = z.infer<typeof haConfig>;

export const haSecrets = z.object({ homeToken: z.string().trim().min(20, "Paste the whole long-lived access token.").max(2000) });

export const haManifest = defineManifest({
  id: "home_assistant", version: "1", status: "official", icon: "home",
  graphKinds: HA_GRAPH_KINDS,
  auth: { type: "api_key" },
  config: haConfig,
  secrets: haSecrets,
  fields: [
    { key: "homeUrl", kind: "url", required: true, placeholder: "https://example.ui.nabu.casa" },
    { key: "homeToken", kind: "password", secret: true, required: true },
    { key: "maintenance", kind: "boolean" },
    { key: "logbookEntities", kind: "list" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "home", key: "area id, device id", cursor: "how many areas and devices were seen", resetOn: [] },
    { name: "maintenance", key: "entity id (+ latest version)", cursor: "what was already proposed", resetOn: [] },
    { name: "logbook", key: "day", cursor: "where the next read starts", resetOn: [] },
  ],
  schedule: { everyMinutes: 360 },
  rateLimit: { perMinute: 30, backoff: "exponential" },
  maps: { home: "place", maintenance: "task", logbook: "activity" },
});

export type HaDeps = { api: Api; base: string; importBatch: ImportBatch };
export type MaintenanceCursor = { sent?: string[] };
export type LogbookCursor = { from?: string };

const LOGBOOK_DAYS_BACK = 7;
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

async function getJson<T>(d: HaDeps, path: string, what: string): Promise<T> {
  const r = await d.api({ url: `${d.base}${path}` });
  if (r.status !== 200) throw unexpected(r, "Home Assistant", what);
  return bodyOf<T>(r, "Home Assistant");
}

export async function syncHomeAssistant(ctx: RunContext<HaConfig>, d: HaDeps): Promise<void> {
  const conf = await getJson<{ location_name?: string }>(d, "/api/config", "its settings");
  const name = conf.location_name?.trim() || "Home";

  // Rooms and devices: one template render (the REST API has no area or device list).
  const t = await d.api({ url: `${d.base}/api/template`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template: HOME_TEMPLATE }), maxBytes: 4 * 1024 * 1024 });
  if (t.status === 401 || t.status === 403) throw needsYou("Home Assistant only lists rooms and devices for an administrator's token. Make the long-lived access token while signed in as an administrator.", "forbidden");
  if (t.status === 400) throw needsYou("Home Assistant couldn't list rooms and devices. It may be older than 2023.1; update it and try again.", "httpOther");
  if (t.status !== 200) throw unexpected(t, "Home Assistant", "the rooms and devices");
  let answer: TemplateAnswer;
  try { answer = JSON.parse(t.body.toString("utf8")) as TemplateAnswer; } catch { throw willRetry("Home Assistant's list of rooms and devices couldn't be read.", "serverError"); }
  const home = homePayload(name, answer);
  ctx.count("home", "fetched", home.areas.length + home.devices.length);
  if (home.areas.length || home.devices.length) {
    const r = await d.importBatch({ bytes: enc(home), title: `Home Assistant: ${name}`, externalId: "ha:home" });
    ctx.count("home", r.duplicate ? "unchanged" : "added");
  }
  await ctx.commit("home", { areas: home.areas.length, devices: home.devices.length }, async () => {});

  if (ctx.config.maintenance) {
    const states = await getJson<HaState[]>(d, "/api/states", "the states");
    const names = new Map(home.devices.map((x) => [x.id, x.name]));
    const items = maintenanceItems(Array.isArray(states) ? states : [], answer.links ?? [], names);
    const sent = new Set(cursorOf<MaintenanceCursor>(ctx.state(), "maintenance")?.sent ?? []);
    const fresh = items.filter((i) => !sent.has(i.key));
    if (fresh.length) {
      const id = createHash("sha256").update(fresh.map((i) => i.key).join("\n")).digest("hex").slice(0, 24);
      const r = await d.importBatch({
        bytes: enc({ kind: "maintenance", home: { name }, items: fresh }),
        title: `Home Assistant: ${fresh.length} ${fresh.length === 1 ? "thing needs" : "things need"} attention`, externalId: `ha:maintenance:${id}`,
      });
      ctx.count("maintenance", r.duplicate ? "unchanged" : "proposed", fresh.length);
    }
    // Only what is still low or pending is remembered, so it comes back if it happens again later.
    await ctx.commit("maintenance", { sent: items.map((i) => i.key) } satisfies MaintenanceCursor, async () => {});
  }

  const entities = ctx.config.logbookEntities;
  if (entities.length) {
    const startOfDay = (ms: number) => new Date(Math.floor(ms / 86_400_000) * 86_400_000);
    const from = cursorOf<LogbookCursor>(ctx.state(), "logbook")?.from ?? startOfDay(ctx.now.getTime() - LOGBOOK_DAYS_BACK * 86_400_000).toISOString();
    const q = new URLSearchParams({ entity: entities.join(","), end_time: ctx.now.toISOString() });
    const entries = await getJson<LogbookEntry[]>(d, `/api/logbook/${encodeURIComponent(from)}?${q}`, "the logbook");
    for (const day of logbookDays(name, Array.isArray(entries) ? entries : [])) {
      const r = await d.importBatch({ bytes: enc(day), title: `Home Assistant logbook, ${day.day}`, externalId: `ha:logbook:${day.day}` });
      ctx.count("logbook", r.duplicate ? "unchanged" : "added");
    }
    // Today is read again next time, so its source grows through the day.
    await ctx.commit("logbook", { from: startOfDay(ctx.now.getTime()).toISOString() } satisfies LogbookCursor, async () => {});
  }
}
