import { describe, expect, it } from "vitest";
import { checkUrl } from "../ssrf";
import { cursorOf } from "../state";
import { fakeApi, fakeCtx } from "../oauth/testing";
import { homeAssistantImporter, reminderTitle } from "@/lib/importers/home_assistant";
import type { ImportContext } from "@/lib/importers/types";
import type { ImportBatch } from "../slack/connector";
import { haConfig, haSecrets, syncHomeAssistant, type MaintenanceCursor } from "./connector";
import { HOME_TEMPLATE, homePayload, maintenanceItems, type HaState } from "./map";

const BASE = "https://abc.ui.nabu.casa";
const NOW = new Date("2026-11-04T10:00:00Z");

const TEMPLATE = {
  areas: [{ id: "kitchen", name: "Kitchen" }, { id: "hall", name: "Hallway" }],
  devices: [
    { id: "d1", name: "Kitchen lamp", manufacturer: "IKEA", model: "TRADFRI bulb", area: "kitchen", entry: "None" },
    { id: "d2", name: "Door sensor", manufacturer: "Aqara", model: "MCCGQ11LM", area: "hall", entry: "None" },
    { id: "d3", name: "Forecast", manufacturer: "Met.no", model: null, area: null, entry: "DeviceEntryType.SERVICE" },
  ],
  links: [{ e: "sensor.door_battery", d: "d2" }, { e: "update.lamp_firmware", d: "d1" }],
};

let STATES: HaState[] = [];
const resetStates = () => {
  STATES = [
    { entity_id: "sensor.door_battery", state: "12", attributes: { device_class: "battery", unit_of_measurement: "%", friendly_name: "Door battery" } },
    { entity_id: "sensor.remote_battery", state: "80", attributes: { device_class: "battery", unit_of_measurement: "%" } },
    { entity_id: "update.lamp_firmware", state: "on", attributes: { installed_version: "1.0", latest_version: "1.1", title: "Firmware" } },
    { entity_id: "light.kitchen", state: "on", attributes: {} },
  ];
};

function haServer() {
  return fakeApi(({ u, method, body }) => {
    if (u.pathname === "/api/config") return { json: { location_name: "Holm home", version: "2026.10.1" } };
    if (u.pathname === "/api/template" && method === "POST") {
      expect(JSON.parse(String(body)).template).toBe(HOME_TEMPLATE);
      return { body: JSON.stringify(TEMPLATE) };
    }
    if (u.pathname === "/api/states") return { json: STATES };
    if (u.pathname.startsWith("/api/logbook/")) {
      expect(u.searchParams.get("entity")).toBe("lock.front_door");
      return { json: [
        { when: "2026-11-03T21:00:00+00:00", name: "Front door", message: "was locked", entity_id: "lock.front_door" },
        { when: "2026-11-04T07:30:00+00:00", name: "Front door", message: "was unlocked", entity_id: "lock.front_door" },
      ] };
    }
    return undefined;
  });
}

function recorder() {
  const batches: { title: string; externalId: string; json: Record<string, unknown> }[] = [];
  const seen = new Map<string, string>();
  const importBatch: ImportBatch = async (b) => {
    const text = new TextDecoder().decode(b.bytes);
    const duplicate = seen.get(b.externalId) === text;
    seen.set(b.externalId, text);
    if (!duplicate) batches.push({ title: b.title, externalId: b.externalId, json: JSON.parse(text) });
    return { sourceId: "s", duplicate };
  };
  return { batches, importBatch };
}

describe("Home Assistant address", () => {
  const prod = { NODE_ENV: "production" };
  it("allows a public https address (Nabu Casa or the home's own domain)", () => {
    expect(checkUrl("https://abc.ui.nabu.casa", prod).hostname).toBe("abc.ui.nabu.casa");
  });
  it("refuses the home network in production", () => {
    expect(() => checkUrl("http://homeassistant.local:8123", prod)).toThrow();
    expect(() => checkUrl("https://homeassistant.local", prod)).toThrow(/home network|internet/);
    expect(() => checkUrl("https://192.168.1.20", prod)).toThrow(/home network|internet/);
    expect(() => checkUrl("https://ha.example.dk:8123", prod)).toThrow(/standard web port/);
  });
  it("needs a whole token", () => {
    expect(haSecrets.safeParse({ homeToken: "short" }).success).toBe(false);
    expect(haConfig.safeParse({ homeUrl: BASE, logbookEntities: ["not an entity"] }).success).toBe(false);
  });
});

describe("Home Assistant mapping", () => {
  it("keeps rooms and devices, not integration services, in stable order", () => {
    const p = homePayload("Holm home", TEMPLATE);
    expect(p.areas.map((a) => a.id)).toEqual(["hall", "kitchen"]);
    expect(p.devices.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(p.devices[0]).toEqual({ id: "d1", name: "Kitchen lamp", manufacturer: "IKEA", model: "TRADFRI bulb", areaId: "kitchen" });
  });
  it("finds low batteries and updates, named by their device", () => {
    resetStates();
    const items = maintenanceItems(STATES, TEMPLATE.links, new Map([["d1", "Kitchen lamp"], ["d2", "Door sensor"]]));
    expect(items).toEqual([
      { entityId: "sensor.door_battery", name: "Door sensor", deviceId: "d2", key: "battery:sensor.door_battery", what: "battery", level: 12 },
      { entityId: "update.lamp_firmware", name: "Kitchen lamp", deviceId: "d1", key: "update:update.lamp_firmware:1.1", what: "update", installed: "1.0", latest: "1.1", title: "Firmware" },
    ]);
    expect(reminderTitle(items[0], "en")).toBe("Change the battery: Door sensor (12%)");
    expect(reminderTitle(items[1], "da")).toBe("Opdatering klar: Kitchen lamp (Firmware) 1.0 → 1.1");
  });
});

describe("Home Assistant sync", () => {
  it("sends the home once, each maintenance item once while it lasts, and the logbook by day", async () => {
    resetStates();
    const rec = recorder();
    const ctx = fakeCtx("home_assistant", haConfig.parse({ homeUrl: BASE, maintenance: true, logbookEntities: ["lock.front_door"] }), {}, NOW);
    await syncHomeAssistant(ctx, { api: haServer(), base: BASE, importBatch: rec.importBatch });
    expect(rec.batches.map((b) => b.externalId.replace(/maintenance:.*/, "maintenance:*"))).toEqual(["ha:home", "ha:maintenance:*", "ha:logbook:2026-11-03", "ha:logbook:2026-11-04"]);
    expect((rec.batches[1].json.items as unknown[]).length).toBe(2);
    expect(cursorOf<MaintenanceCursor>(ctx.state(), "maintenance")?.sent).toHaveLength(2);

    // Same state next time: nothing new. The battery is changed, then runs low again later → proposed again.
    rec.batches.length = 0;
    await syncHomeAssistant(ctx, { api: haServer(), base: BASE, importBatch: rec.importBatch });
    expect(rec.batches).toEqual([]);
    STATES[0] = { ...STATES[0], state: "100" };
    await syncHomeAssistant(ctx, { api: haServer(), base: BASE, importBatch: rec.importBatch });
    expect(rec.batches).toEqual([]);
    STATES[0] = { ...STATES[0], state: "15" };
    await syncHomeAssistant(ctx, { api: haServer(), base: BASE, importBatch: rec.importBatch });
    expect(rec.batches.map((b) => (b.json.items as { key: string }[] | undefined)?.map((i) => i.key))).toEqual([["battery:sensor.door_battery"]]);
  });

  it("asks for an administrator's token when the template is refused", async () => {
    const api = fakeApi(({ u }) => (u.pathname === "/api/config" ? { json: {} } : { status: 403, json: { message: "Unauthorized" } }));
    await expect(syncHomeAssistant(fakeCtx("home_assistant", haConfig.parse({ homeUrl: BASE }), {}, NOW), { api, base: BASE, importBatch: recorder().importBatch }))
      .rejects.toMatchObject({ kind: "needs_you", code: "forbidden" });
  });
});

function ctxFor(over: Partial<ImportContext> = {}): ImportContext {
  let n = 0;
  return { sourceId: "src1", graphKind: "family", visibility: "household", known: [], existingEdges: new Set(), now: NOW, mint: () => `n${++n}`, locale: "en", ...over };
}
const enc = (o: unknown) => Buffer.from(JSON.stringify(o));
type Op = { op: string; label?: string; kind?: string; key?: string; fromId?: string; toId?: string; relation?: string; title?: string; aboutNodeId?: string | null; dueAt?: string };

describe("home_assistant importer", () => {
  it("proposes the home, its rooms and devices, reusing the family's home", () => {
    const known = [
      { id: "home", type: "place", kind: "home", label: "Our house", aliases: [], startAt: null, props: {} },
      { id: "kitchen", type: "place", kind: null, label: "Kitchen", aliases: [], startAt: null, props: {} },
    ];
    const plan = homeAssistantImporter.read({ filename: "x", bytes: enc(homePayload("Holm home", TEMPLATE)) }, ctxFor({ known })) as { changes: Op[]; counts: Record<string, number>; extract?: boolean };
    const ops = plan.changes;
    expect(ops.filter((c) => c.op === "addKind").map((c) => c.key)).toEqual(["room", "device"]);
    expect(ops.filter((c) => c.op === "addNode").map((c) => [c.label, c.kind])).toEqual([["Hallway", "room"], ["Door sensor", "device"], ["Kitchen lamp", "device"]]);
    const edges = ops.filter((c) => c.op === "addEdge").map((c) => `${c.fromId} ${c.relation} ${c.toId}`);
    expect(edges).toEqual(["n1 located_at home", "kitchen located_at home", "n2 located_at n1", "n3 located_at kitchen"]);
    expect(plan.extract).toBe(false);
    expect(plan.counts).toMatchObject({ rooms: 1, devices: 2, matched: 1 });
  });

  it("turns maintenance items into reminders about the known device", () => {
    const known = [{ id: "dev-2", type: "thing", kind: "device", label: "Door sensor", aliases: [], startAt: null, props: { haDeviceId: "d2" } }];
    const plan = homeAssistantImporter.read({ filename: "x", bytes: enc({ kind: "maintenance", home: { name: "Holm home" }, items: [
      { key: "battery:sensor.door_battery", what: "battery", entityId: "sensor.door_battery", name: "Door sensor", deviceId: "d2", level: 12 },
    ] }) }, ctxFor({ known, locale: "da" })) as { changes: Op[]; title?: string };
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ op: "addReminder", title: "Skift batteriet: Door sensor (12%)", aboutNodeId: "dev-2", dueAt: "2026-11-07T10:00:00.000Z" });
    expect(plan.title).toBe("Home Assistant: 1 ting skal ses efter");
  });

  it("keeps a logbook day as text only", () => {
    const plan = homeAssistantImporter.read({ filename: "x", bytes: enc({ kind: "logbook", home: { name: "Holm home" }, day: "2026-11-04", entries: [{ when: "2026-11-04T07:30:00.000Z", name: "Front door", message: "was unlocked", entityId: "lock.front_door" }] }) }, ctxFor()) as { segments: { text: string }[]; changes: unknown[]; extract?: boolean };
    expect(plan.segments[1].text).toBe("07:30 UTC Front door: was unlocked");
    expect(plan.changes).toEqual([]);
    expect(plan.extract).toBe(false);
  });
});
