/**
 * Spond (unofficial, read-only): the teams, trainings, matches and tournaments of the children on a parent's Spond
 * login (or the person's own, in a personal graph). Server-only.
 *
 * Spond has no public API for families; this uses the API its own apps use (api.spond.com/core/v1), the way the
 * open-source clients do: sign in with email and password for a token, read the profile, groups and events from 30 days
 * back to 120 days ahead. The email and password are encrypted secrets, used only to sign in and never logged.
 * What it brings in goes through the shared sports run (../sports/sync.ts): an event source per event and proposals.
 * It never answers an invitation, writes a comment or changes anything in Spond.
 */
import { z } from "zod";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { needsYou, willRetry } from "../errors";
import { defineManifest } from "../manifest";
import type { Connector, RunContext } from "../types";
import { sportsConfig, windowOf, type SportsConfig } from "../sports/model";
import { syncSports } from "../sports/sync";
import { SpondApi, SpondError, spondBase } from "./client";
import { SPOND_WEB, spondSnapshot } from "./mapping";

export const spondManifest = defineManifest({
  id: "spond", version: "1", status: "unofficial", icon: "trophy", graphKinds: ["family", "personal"],
  auth: { type: "app_password" },
  config: sportsConfig,
  secrets: z.object({
    spondEmail: z.string().trim().email("Type the email you sign in to Spond with.").max(320),
    spondPassword: z.string().min(1, "Type your Spond password.").max(500),
  }),
  fields: [
    { key: "spondEmail", kind: "text", secret: true, required: true, placeholder: "name@example.com" },
    { key: "spondPassword", kind: "password", secret: true, required: true },
    { key: "sportsChildNodeId", kind: "person" },
    { key: "sportsTeams", kind: "list" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "events", key: "id", cursor: "event id → fingerprint, -30/+120 days", resetOn: [] },
    { name: "teams", key: "groupId", cursor: "mapping to graph nodes", resetOn: [] },
  ],
  // Polite: Spond is unofficial, so at most hourly and a handful of requests a minute.
  schedule: { everyMinutes: 180 },
  rateLimit: { perMinute: 10, backoff: "exponential" },
  maps: { events: "activity", teams: "person" },
});

export function asConnectorError(e: unknown): unknown {
  if (!(e instanceof SpondError)) return e;
  switch (e.kind) {
    case "auth": return needsYou("Spond didn't accept the email or password. Type them again in the connection's settings.", "spondAuth");
    case "privateHost": return needsYou(e.message, "privateHost");
    case "rate": return willRetry("Spond asked us to slow down.", "rateLimited");
    case "network": return willRetry("Spond couldn't be reached.", "network");
    case "shape": return willRetry("Spond answered with something unexpected. This connection is unofficial and may stop working.", "spondChanged");
    default: return e.status && e.status >= 500 ? willRetry(e.message, "serverError") : willRetry(`${e.message} This connection is unofficial and may stop working.`, "spondChanged");
  }
}

export async function syncSpond(ctx: RunContext<SportsConfig>, transport: Transport = guardedTransport()): Promise<void> {
  const email = ctx.secrets.spondEmail ?? "", password = ctx.secrets.spondPassword ?? "";
  if (!email || !password) throw needsYou("Type the email and password you sign in to Spond with.", "spondAuth");
  const api = new SpondApi({ transport, base: spondBase(ctx.config.apiBase), throttle: () => ctx.throttle(), signal: ctx.signal });
  await api.login(email, password);
  const { from, to } = windowOf(ctx.now);
  const profile = await api.profile();
  const groups = await api.groups();
  const events = await api.events(from, to);
  const snapshot = spondSnapshot(profile, groups, events);
  if (!snapshot.members.length) ctx.log("Spond lists nobody on this login as you or a child you are a guardian of, so there is nothing to bring in.");
  await syncSports(ctx, snapshot, { webUrl: SPOND_WEB });
}

export const spondConnector: Connector<SportsConfig> = {
  manifest: spondManifest,
  check(_c, s) {
    if (!s.spondEmail || !s.spondPassword) throw needsYou("Type the email and password you sign in to Spond with.", "spondAuth");
  },
  describe() { return { feedHost: "spond.com" }; },
  async sync(ctx) {
    try {
      await syncSpond(ctx);
    } catch (e) {
      throw asConnectorError(e);
    }
  },
};
