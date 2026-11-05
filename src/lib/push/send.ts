/**
 * Sending one thing to one person (server-only): their settings, quiet hours and daily cap decide; the delivery key
 * makes sure it goes once even with two app instances; every device gets it in its own language; tokens APNs says
 * are gone are deleted.
 */
import type { ApnsSender } from "./apns";
import {
  buildPayload, categoryOf, collapseIdFor, gate, inQuietHours, tokenTail,
  type ApnsEnv, type Gate, type PushItem,
} from "./pure";
import * as store from "./store";

export type DeviceTarget = { token: string; locale: string | null; environment: string | null };

/**
 * Sends to every device. Tokens APNs rejects as unregistered or bad are passed to `onInvalid` (which deletes them).
 * Returns how many devices took it.
 */
export async function sendToDevices(
  sender: ApnsSender,
  devices: DeviceTarget[],
  item: PushItem,
  fallbackLocale: string,
  onInvalid: (token: string) => Promise<void>,
): Promise<{ sent: number; invalid: number; failed: number }> {
  let sent = 0, invalid = 0, failed = 0;
  for (const d of devices) {
    const payload = buildPayload(item, d.locale ?? fallbackLocale);
    const env: ApnsEnv | null = d.environment === "sandbox" || d.environment === "production" ? d.environment : null;
    const r = await sender.send(d.token, payload, { collapseId: collapseIdFor(item), env });
    if (r.outcome === "sent") sent++;
    else if (r.outcome === "invalid_token") {
      invalid++;
      await onInvalid(d.token).catch(() => {});
      console.log(`[push] removed a device APNs no longer knows (${tokenTail(d.token)}, ${r.reason ?? r.status}).`);
    } else {
      failed++;
      console.error(`[push] APNs refused a notification (${r.status} ${r.reason ?? ""}) for ${tokenTail(d.token)}.`);
    }
  }
  return { sent, invalid, failed };
}

export type DeliverResult = { sent: boolean; reason?: Exclude<Gate, { send: true }>["reason"] | "duplicate" | "no_device" | "failed" | "unknown_user" };

/** Decides and sends one item to one person. `key` is what makes it go once. */
export async function deliverPush(sender: ApnsSender, userId: string, item: PushItem, key: string, now = new Date()): Promise<DeliverResult> {
  const who = await store.userTimeZone(userId);
  if (!who) return { sent: false, reason: "unknown_user" };
  const prefs = await store.getPrefs(userId);
  const category = categoryOf(item);
  const graphId = "graphId" in item ? item.graphId : null;
  const [cap, count] = await Promise.all([store.dailyCap(userId, graphId), store.sentToday(userId, graphId, who.timeZone, now)]);
  const g = gate({
    category, enabled: prefs.enabled, categories: prefs.categories,
    quiet: inQuietHours(now, who.timeZone, prefs.quietStart, prefs.quietEnd), sentToday: count, cap,
  });
  if (!g.send) return { sent: false, reason: g.reason };

  const devices = await store.devicesOf(userId);
  if (!devices.length) return { sent: false, reason: "no_device" };
  const claim = await store.claimDelivery({ userId, graphId, key, category, counted: g.counted });
  if (!claim) return { sent: false, reason: "duplicate" };

  const r = await sendToDevices(sender, devices, item, who.locale, store.deleteDeviceToken);
  if (r.sent > 0) { await store.finishDelivery(claim, "sent", r.sent); return { sent: true }; }
  if (r.failed > 0) { await store.releaseDelivery(claim); return { sent: false, reason: "failed" }; }
  await store.finishDelivery(claim, "no_device", 0);
  return { sent: false, reason: "no_device" };
}
