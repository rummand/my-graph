/**
 * Home Assistant's answers turned into the importer's batches (pure).
 *
 * Areas and devices aren't in Home Assistant's REST API (only its WebSocket API), so they are read with one template
 * render (POST /api/template, which needs a token of an administrator): the template below answers JSON with the
 * areas, every device that has an entity, and which device each battery and update entity belongs to.
 */
import type { HaHomePayload, HaLogbookPayload, HaMaintenancePayload } from "@/lib/importers/home_assistant/schema";

export const HOME_TEMPLATE = `{%- set ns = namespace(areas=[], devices=[], ids=[], links=[]) -%}
{%- for a in areas() -%}{%- set ns.areas = ns.areas + [{"id": a, "name": area_name(a)}] -%}{%- endfor -%}
{%- for s in states -%}
{%- set d = device_id(s.entity_id) -%}
{%- if d -%}
{%- if d not in ns.ids -%}{%- set ns.ids = ns.ids + [d] -%}{%- endif -%}
{%- if s.domain == "update" or s.attributes.get("device_class") == "battery" -%}{%- set ns.links = ns.links + [{"e": s.entity_id, "d": d}] -%}{%- endif -%}
{%- endif -%}
{%- endfor -%}
{%- for d in ns.ids -%}
{%- set ns.devices = ns.devices + [{"id": d, "name": device_attr(d, "name_by_user") or device_attr(d, "name"), "manufacturer": device_attr(d, "manufacturer"), "model": device_attr(d, "model"), "area": area_id(d), "entry": device_attr(d, "entry_type") | string}] -%}
{%- endfor -%}
{{ {"areas": ns.areas, "devices": ns.devices, "links": ns.links} | tojson }}`;

export type TemplateAnswer = {
  areas?: { id: string; name: string | null }[];
  devices?: { id: string; name: string | null; manufacturer?: string | null; model?: string | null; area?: string | null; entry?: string | null }[];
  links?: { e: string; d: string }[];
};

export type HaState = { entity_id: string; state: string; attributes?: Record<string, unknown> };
export type LogbookEntry = { when?: string; name?: string; message?: string; state?: string; entity_id?: string };

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

/** Areas and devices as the home batch. Integration "services" (weather, sun) aren't things in the home. */
export function homePayload(name: string, t: TemplateAnswer): HaHomePayload {
  const areas = (t.areas ?? []).filter((a) => a.id && a.name).map((a) => ({ id: a.id.slice(0, 200), name: a.name!.slice(0, 200) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const devices = (t.devices ?? [])
    .filter((d) => d.id && d.name && !/service/i.test(d.entry ?? ""))
    .map((d) => ({
      id: d.id.slice(0, 200), name: d.name!.slice(0, 300),
      ...(str(d.manufacturer, 300) ? { manufacturer: str(d.manufacturer, 300) } : {}),
      ...(str(d.model, 300) ? { model: str(d.model, 300) } : {}),
      ...(str(d.area, 200) ? { areaId: str(d.area, 200) } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { kind: "home", home: { name: name.slice(0, 200) }, areas, devices };
}

export const BATTERY_LOW = 20;

export type MaintenanceItem = HaMaintenancePayload["items"][number];

/** Low batteries and available updates, keyed so the same one is proposed only once while it lasts. */
export function maintenanceItems(states: HaState[], links: { e: string; d: string }[], deviceNames: Map<string, string>): MaintenanceItem[] {
  const deviceOf = new Map(links.map((l) => [l.e, l.d]));
  const out: MaintenanceItem[] = [];
  for (const s of states) {
    const a = s.attributes ?? {};
    const domain = s.entity_id.split(".")[0];
    const deviceId = deviceOf.get(s.entity_id);
    const name = (deviceId && deviceNames.get(deviceId)) || str(a.friendly_name, 300) || s.entity_id;
    const base = { entityId: s.entity_id.slice(0, 300), name: name.slice(0, 300), ...(deviceId ? { deviceId } : {}) };
    if (a.device_class === "battery" && domain === "sensor" && a.unit_of_measurement === "%") {
      const level = Number(s.state);
      if (Number.isFinite(level) && level >= 0 && level <= BATTERY_LOW) out.push({ ...base, key: `battery:${s.entity_id}`, what: "battery", level });
    } else if (a.device_class === "battery" && domain === "binary_sensor" && s.state === "on") {
      out.push({ ...base, key: `battery:${s.entity_id}`, what: "battery" });
    } else if (domain === "update" && s.state === "on") {
      const latest = str(a.latest_version, 200);
      out.push({
        ...base, key: `update:${s.entity_id}:${latest ?? ""}`, what: "update",
        ...(str(a.installed_version, 200) ? { installed: str(a.installed_version, 200) } : {}), ...(latest ? { latest } : {}),
        ...(str(a.title, 300) ? { title: str(a.title, 300) } : {}),
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Logbook entries grouped into one batch per UTC day. */
export function logbookDays(name: string, entries: LogbookEntry[]): HaLogbookPayload[] {
  const byDay = new Map<string, HaLogbookPayload["entries"]>();
  for (const e of entries) {
    if (!e.when || Number.isNaN(Date.parse(e.when))) continue;
    const when = new Date(e.when).toISOString();
    const day = when.slice(0, 10);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push({
      when, name: (e.name ?? e.entity_id ?? "?").slice(0, 300),
      ...(str(e.message, 1000) ? { message: str(e.message, 1000) } : {}), ...(str(e.state, 300) ? { state: str(e.state, 300) } : {}),
      ...(str(e.entity_id, 300) ? { entityId: str(e.entity_id, 300) } : {}),
    });
  }
  return [...byDay.keys()].sort().map((day) => ({ kind: "logbook" as const, home: { name: name.slice(0, 200) }, day, entries: byDay.get(day)!.sort((a, b) => a.when.localeCompare(b.when)) }));
}

/** "https://abc.ui.nabu.casa/" → "https://abc.ui.nabu.casa" (no path, no trailing slash). */
export function baseOf(url: string): string {
  const u = new URL(url.trim());
  return `${u.protocol}//${u.host}`;
}

export const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
