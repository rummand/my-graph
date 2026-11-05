/**
 * Home Assistant importer (pure): reads the batches the Home Assistant connector keeps.
 *
 *   home         the home becomes a place (kind "home"), its areas places of kind "room" located at it, and its
 *                devices things of kind "device" (manufacturer, model) located in their room. Known nodes are matched
 *                by their Home Assistant id first, then by a label unique in the graph, and never changed.
 *   maintenance  a low battery or an available update becomes a reminder proposal about the device.
 *   logbook      a day of the chosen entities' logbook, as searchable text (no proposals, no model).
 * Kinds and the "located at" relation come from the meta model (addKind is reused when the key exists).
 */
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { edgeKey, matchByLabel } from "../match";
import type { ImportContext, ImportKnown, ImportPlan, Importer } from "../types";
import { haPayload, type HaHomePayload, type HaLogbookPayload, type HaMaintenancePayload, type HaPayload } from "./schema";

/** A home's things suit a family graph and anyone's own (personal, partner, shared, other); not work or a practice. */
export const HA_GRAPH_KINDS = ["family", "personal", "partner", "shared", "other"];
const MAX_DEVICES = 300;

export const ROOM_KIND = { op: "addKind", nodeType: "place", key: "room", label: "Room", pluralLabel: "Rooms", description: "A room or area of a home: kitchen, garage, garden." } as const;
export const DEVICE_KIND = { op: "addKind", nodeType: "thing", key: "device", label: "Device", pluralLabel: "Devices", description: "A device in the home: a thermostat, a lamp, a sensor, a speaker." } as const;

function parse(bytes: Buffer): { data: HaPayload | null; problem: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return { data: null, problem: "The Home Assistant batch isn't valid JSON." }; }
  const r = haPayload.safeParse(raw);
  return r.success ? { data: r.data, problem: null } : { data: null, problem: `The Home Assistant batch doesn't have the expected shape (${r.error.issues[0]?.path.join(".") || "root"}).` };
}

/** The known node carrying this Home Assistant id in props, else the one of this type with this unique label. */
export function matchHa(known: ImportKnown[], type: string, propKey: string, id: string, label: string): ImportKnown | null {
  const byId = known.find((k) => k.type === type && k.props[propKey] === id);
  return byId ?? matchByLabel(known, type, label);
}

/** The home: by label, else the only place of kind "home" in the graph. */
export function matchHome(known: ImportKnown[], name: string): ImportKnown | null {
  const byLabel = matchByLabel(known, "place", name);
  if (byLabel) return byLabel;
  const homes = known.filter((k) => k.type === "place" && k.kind === "home");
  return homes.length === 1 ? homes[0] : null;
}

export function deviceLine(d: { name: string; manufacturer?: string; model?: string }, room?: string | null): string {
  const what = [d.manufacturer, d.model].filter(Boolean).join(" ");
  return `${d.name}${what ? ` (${what})` : ""}${room ? ` in ${room}` : ""}`;
}

function readHome(d: HaHomePayload, ctx: ImportContext): ImportPlan {
  const segments: TextSegment[] = [];
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  const head = `Home Assistant: ${d.home.name}, ${d.areas.length} areas, ${d.devices.length} devices`;
  segments.push({ text: head, at: { region: "home" } });
  const home = matchHome(ctx.known, d.home.name);
  const homeId = home?.id ?? ctx.mint();
  if (!home) {
    changes.push({ op: "addNode", nodeId: homeId, type: "place", kind: "home", label: d.home.name, visibility: ctx.visibility, receipt: { sourceId: ctx.sourceId, quote: head, locator: { region: "home" } } });
  }
  const areaNode = new Map<string, { id: string; name: string }>();
  let rooms = 0, devices = 0, matched = 0, roomKind = false, deviceKind = false;
  for (const a of [...d.areas].sort((x, y) => x.name.localeCompare(y.name))) {
    const line = `Area: ${a.name}`;
    segments.push({ text: line, at: { region: `area:${a.id}` } });
    const receipt = { sourceId: ctx.sourceId, quote: line, locator: { region: `area:${a.id}` } };
    const hit = matchHa(ctx.known, "place", "haAreaId", a.id, a.name);
    if (hit) { matched++; areaNode.set(a.id, { id: hit.id, name: a.name }); }
    else {
      if (!roomKind) { changes.push({ ...ROOM_KIND, receipt }); roomKind = true; }
      const id = ctx.mint();
      changes.push({ op: "addNode", nodeId: id, type: "place", kind: "room", label: a.name, props: { haAreaId: a.id }, visibility: ctx.visibility, receipt });
      areaNode.set(a.id, { id, name: a.name });
      rooms++;
    }
    const roomId = areaNode.get(a.id)!.id;
    if (roomId !== homeId && !(hit && home && ctx.existingEdges.has(edgeKey(roomId, "located_at", homeId)))) {
      changes.push({ op: "addEdge", fromId: roomId, toId: homeId, relation: "located_at", confidence: 1, status: "confirmed", receipt });
    }
  }
  let left = 0;
  for (const dev of [...d.devices].sort((x, y) => x.name.localeCompare(y.name))) {
    const area = dev.areaId ? areaNode.get(dev.areaId) ?? null : null;
    const line = `Device: ${deviceLine(dev, area?.name)}`;
    segments.push({ text: line, at: { region: `device:${dev.id}` } });
    const receipt = { sourceId: ctx.sourceId, quote: line.slice(0, 300), locator: { region: `device:${dev.id}` } };
    const hit = matchHa(ctx.known, "thing", "haDeviceId", dev.id, dev.name);
    let id: string;
    if (hit) { matched++; id = hit.id; }
    else {
      if (devices >= MAX_DEVICES) { left++; continue; }
      if (!deviceKind) { changes.push({ ...DEVICE_KIND, receipt }); deviceKind = true; }
      id = ctx.mint();
      const what = [dev.manufacturer, dev.model].filter(Boolean).join(" ");
      changes.push({
        op: "addNode", nodeId: id, type: "thing", kind: "device", label: dev.name, ...(what ? { summary: what } : {}),
        props: { haDeviceId: dev.id, ...(dev.manufacturer ? { manufacturer: dev.manufacturer } : {}), ...(dev.model ? { model: dev.model } : {}) },
        visibility: ctx.visibility, receipt,
      });
      devices++;
    }
    if (area && !(hit && ctx.existingEdges.has(edgeKey(id, "located_at", area.id)))) {
      changes.push({ op: "addEdge", fromId: id, toId: area.id, relation: "located_at", confidence: 1, status: "confirmed", receipt });
    }
  }
  if (left) warnings.push(`${left} more devices weren't proposed this time; deliver or drop these first.`);
  return { segments, changes, warnings, extract: false, counts: { rooms, devices, matched }, title: `Home Assistant: ${d.home.name}` };
}

export function reminderTitle(i: HaMaintenancePayload["items"][number], locale: "en" | "da"): string {
  if (i.what === "battery") {
    const lvl = i.level != null ? ` (${Math.round(i.level)}%)` : "";
    return locale === "da" ? `Skift batteriet: ${i.name}${lvl}` : `Change the battery: ${i.name}${lvl}`;
  }
  const v = i.latest ? (i.installed ? ` ${i.installed} → ${i.latest}` : ` ${i.latest}`) : "";
  const what = i.title && i.title !== i.name ? `${i.name} (${i.title})` : i.name;
  return locale === "da" ? `Opdatering klar: ${what}${v}` : `Update available: ${what}${v}`;
}

function readMaintenance(d: HaMaintenancePayload, ctx: ImportContext): ImportPlan {
  const segments: TextSegment[] = [];
  const changes: ChangeInput[] = [];
  let reminders = 0;
  for (const i of d.items) {
    const line = i.what === "battery"
      ? `Low battery: ${i.name}${i.level != null ? ` at ${Math.round(i.level)}%` : ""} (${i.entityId})`
      : `Update available for ${i.title ?? i.name}: ${i.installed ?? "?"} → ${i.latest ?? "?"} (${i.entityId})`;
    segments.push({ text: line, at: { region: `entity:${i.entityId}` } });
    const about = i.deviceId ? matchHa(ctx.known, "thing", "haDeviceId", i.deviceId, i.name) : null;
    const days = i.what === "battery" ? 3 : 7;
    changes.push({
      op: "addReminder", title: reminderTitle(i, ctx.locale), dueAt: new Date(ctx.now.getTime() + days * 86_400_000).toISOString(),
      aboutNodeId: about?.id ?? null, detail: line,
      receipt: { sourceId: ctx.sourceId, quote: line.slice(0, 300), locator: { region: `entity:${i.entityId}` } },
    });
    reminders++;
  }
  const da = ctx.locale === "da";
  return {
    segments, changes, extract: false, counts: { reminders },
    title: da ? `Home Assistant: ${reminders} ting skal ses efter` : `Home Assistant: ${reminders} ${reminders === 1 ? "thing needs" : "things need"} attention`,
    occurredAt: ctx.now,
  };
}

function readLogbook(d: HaLogbookPayload, ctx: ImportContext): ImportPlan {
  const segments: TextSegment[] = [{ text: `Home Assistant logbook, ${d.home.name}, ${d.day}` }];
  const sorted = [...d.entries].sort((a, b) => a.when.localeCompare(b.when));
  for (const e of sorted) {
    segments.push({ text: `${e.when.slice(11, 16)} UTC ${e.name}: ${e.message ?? e.state ?? ""}`.trim(), at: { region: e.entityId ? `entity:${e.entityId}` : "logbook" } });
  }
  const last = sorted.at(-1)?.when;
  return {
    segments, changes: [], extract: false, counts: { entries: d.entries.length },
    title: ctx.locale === "da" ? `Home Assistant-logbog, ${d.day}` : `Home Assistant logbook, ${d.day}`,
    occurredAt: last && !Number.isNaN(Date.parse(last)) ? new Date(last) : null,
  };
}

export const homeAssistantImporter: Importer = {
  id: "home_assistant",
  label: "Home Assistant",
  mime: "application/json",
  // Only the Home Assistant connector makes these sources.
  detect: () => false,
  graphKinds: HA_GRAPH_KINDS,
  read(input, ctx) {
    const { data, problem } = parse(input.bytes);
    if (!data) return { segments: [], changes: [], counts: {}, warnings: [problem!] };
    if (data.kind === "home") return readHome(data, ctx);
    if (data.kind === "maintenance") return readMaintenance(data, ctx);
    return readLogbook(data, ctx);
  },
};
