/**
 * The JSON batches the Home Assistant connector keeps as library sources (pure, shared with
 * src/lib/connectors/home_assistant):
 *   home         the home's areas and devices (stable bytes: no versions or live states, so it is only read again
 *                when a room or a device is added, renamed or moved)
 *   maintenance  things that newly need attention (a low battery, an update), each proposed once as a reminder
 *   logbook      one day of the logbook of the entities the person chose (searchable only)
 */
import { z } from "zod";

const text = (max: number) => z.string().max(max);

export const haHome = z.object({ name: text(200) });

export const haPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("home"),
    home: haHome,
    areas: z.array(z.object({ id: text(200), name: text(200) })).max(1_000),
    devices: z.array(z.object({
      id: text(200), name: text(300), manufacturer: text(300).optional(), model: text(300).optional(), areaId: text(200).optional(),
    })).max(5_000),
  }),
  z.object({
    kind: z.literal("maintenance"),
    home: haHome,
    items: z.array(z.object({
      key: text(500),
      what: z.enum(["battery", "update"]),
      entityId: text(300),
      /** The device's name (or the entity's, when it has no device). */
      name: text(300),
      deviceId: text(200).optional(),
      level: z.number().min(0).max(100).optional(),
      installed: text(200).optional(),
      latest: text(200).optional(),
      title: text(300).optional(),
    })).max(1_000),
  }),
  z.object({
    kind: z.literal("logbook"),
    home: haHome,
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    entries: z.array(z.object({ when: text(40), name: text(300), message: text(1000).optional(), state: text(300).optional(), entityId: text(300).optional() })).max(20_000),
  }),
]);
export type HaPayload = z.infer<typeof haPayload>;
export type HaHomePayload = Extract<HaPayload, { kind: "home" }>;
export type HaMaintenancePayload = Extract<HaPayload, { kind: "maintenance" }>;
export type HaLogbookPayload = Extract<HaPayload, { kind: "logbook" }>;
