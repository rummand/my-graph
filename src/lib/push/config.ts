/**
 * Whether this server can push (server-only). Without the APNs variables it logs once that push is off, and the
 * iPhone app keeps scheduling its own local reminder notifications.
 */
import { ApnsSender, type ApnsTransport } from "./apns";
import { buildApnsJwt, readApnsConfig } from "./pure";

type State = { sender?: ApnsSender | null; logged?: boolean; transport?: ApnsTransport };
const g = globalThis as unknown as { __mgPush?: State };
const state: State = g.__mgPush ?? (g.__mgPush = {});

/** The sender, or null when push is off (missing APNS_* variables or PUSH_DISABLED=1). */
export function pushSender(): ApnsSender | null {
  if (state.sender !== undefined) return state.sender;
  if (process.env.PUSH_DISABLED === "1") {
    logOnce("[push] iPhone push is off (PUSH_DISABLED=1). The app keeps its own reminder notifications.");
    return (state.sender = null);
  }
  const r = readApnsConfig(process.env);
  if ("missing" in r) {
    logOnce(`[push] iPhone push is off: set ${r.missing.join(", ")} (and APNS_ENV) to turn it on. The app keeps its own reminder notifications.`);
    return (state.sender = null);
  }
  try {
    // Sign once now so a broken key shows at start, not at the first reminder. The key itself is never logged.
    buildApnsJwt({ ...r.config, issuedAt: Date.now() / 1000 });
    state.sender = new ApnsSender(r.config, state.transport);
    logOnce(`[push] iPhone push is on (APNs ${r.config.env}, topic ${r.config.bundleId}).`);
  } catch (err) {
    logOnce(`[push] iPhone push is off: APNS_KEY couldn't be read as a .p8 key (${err instanceof Error ? err.name : "error"}).`);
    state.sender = null;
  }
  return state.sender;
}

export function pushEnabled(): boolean {
  return pushSender() !== null;
}

function logOnce(msg: string) {
  if (state.logged) return;
  state.logged = true;
  console.log(msg);
}

/** Tests: use a fake transport and read the environment again. */
export function resetPushForTests(transport?: ApnsTransport): void {
  state.sender = undefined;
  state.logged = false;
  state.transport = transport;
}
