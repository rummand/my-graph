/**
 * Home Assistant connector (server-only). Every request goes through the SSRF-guarded transport with the home's
 * long-lived token as Bearer; the token is never logged or stored anywhere but the connection's encrypted secrets.
 */
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { needsYou } from "../errors";
import { checkUrl } from "../ssrf";
import type { Connector } from "../types";
import { makeApi, transportError, type Api } from "../oauth/client";
import { importerFor } from "../slack";
import { baseOf } from "./map";
import { haManifest, syncHomeAssistant, type HaConfig } from "./connector";

const refused = () => needsYou("Home Assistant refused the access token. Make a new long-lived access token and paste it again.", "badKey");

export function haApi(token: string, opts: { transport?: Transport; signal?: AbortSignal; throttle?: () => Promise<void> } = {}): Api {
  return makeApi({
    transport: opts.transport ?? guardedTransport(), signal: opts.signal, throttle: opts.throttle, who: "Home Assistant",
    token: async () => token,
    // A long-lived token can't be refreshed: a 401 means it was deleted or is wrong.
    refresh: async () => { throw refused(); },
  });
}

export const homeAssistantConnector: Connector<HaConfig> = {
  manifest: haManifest,
  async check(config, secrets) {
    const url = checkUrl(config.homeUrl);
    if (!secrets.homeToken) throw needsYou("Paste a long-lived access token from your Home Assistant profile.", "missingKey");
    // One cheap call, so a wrong address or token is said now rather than at the first run.
    try {
      const r = await haApi(secrets.homeToken)({ url: `${baseOf(url.toString())}/api/`, timeoutMs: 15_000 });
      if (r.status === 404) throw needsYou("Nothing answers like Home Assistant at that address. Use the address you open Home Assistant at.", "notFound");
      if (r.status !== 200) throw needsYou(`Home Assistant answered HTTP ${r.status}. Check the address and the token.`, "httpOther");
    } catch (e) {
      throw e instanceof Error && "kind" in e ? e : transportError(e, "Home Assistant");
    }
  },
  describe(config) {
    try { return { feedHost: new URL(config.homeUrl).hostname }; } catch { return {}; }
  },
  sync: (ctx) => syncHomeAssistant(ctx, {
    api: haApi(ctx.secrets.homeToken ?? "", { signal: ctx.signal, throttle: ctx.throttle }),
    base: baseOf(checkUrl(ctx.config.homeUrl).toString()),
    importBatch: importerFor(ctx, "home_assistant"),
  }),
};
