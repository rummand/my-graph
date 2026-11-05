/**
 * Holdsport (Danish clubs' team app): the trainings, matches and tournaments on a Holdsport login, for the child it
 * belongs to (families usually sign in as the child) or for the person themself. Server-only.
 *
 * Uses Holdsport's documented API (api.holdsport.dk/v1, basic auth): teams, members and activities from 30 days back
 * to 120 days ahead. The user name and password are encrypted secrets, used only for these requests and never logged.
 * What it brings in goes through the shared sports run (../../sports/sync.ts). It never signs anyone up or off.
 */
import { z } from "zod";
import * as gbrain from "@/lib/gbrain";
import { normName } from "@/lib/importers/match";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { needsYou, willRetry } from "../../errors";
import { defineManifest } from "../../manifest";
import type { Connector, RunContext } from "../../types";
import { pickTeams, sportsConfig, windowOf, type SportsConfig } from "../../sports/model";
import { syncSports } from "../../sports/sync";
import { HoldsportApi, HoldsportError, holdsportBase } from "./client";
import { findLoginMember, HOLDSPORT_WEB, holdsportSnapshot, teamsFrom, userFrom, type HoldsportRead } from "./mapping";

export const holdsportManifest = defineManifest({
  id: "holdsport", version: "1", status: "official", icon: "trophy", graphKinds: ["family", "personal"], region: "dk",
  auth: { type: "app_password" },
  config: sportsConfig,
  secrets: z.object({
    holdsportUser: z.string().trim().min(1, "Type the Holdsport user name (usually an email).").max(320),
    holdsportPassword: z.string().min(1, "Type the Holdsport password.").max(500),
  }),
  fields: [
    { key: "holdsportUser", kind: "text", secret: true, required: true, placeholder: "name@example.com" },
    { key: "holdsportPassword", kind: "password", secret: true, required: true },
    { key: "sportsChildNodeId", kind: "person" },
    { key: "sportsTeams", kind: "list" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "events", key: "id", cursor: "activity id → fingerprint, -30/+120 days", resetOn: [] },
    { name: "teams", key: "teamId", cursor: "mapping to graph nodes", resetOn: [] },
  ],
  schedule: { everyMinutes: 120 },
  rateLimit: { perMinute: 20, backoff: "exponential" },
  maps: { events: "activity", teams: "person" },
});

export function asConnectorError(e: unknown): unknown {
  if (!(e instanceof HoldsportError)) return e;
  switch (e.kind) {
    case "auth": return needsYou("Holdsport didn't accept the user name or password. Type them again in the connection's settings.", "holdsportAuth");
    case "privateHost": return needsYou(e.message, "privateHost");
    case "rate": return willRetry("Holdsport asked us to slow down.", "rateLimited");
    case "network": return willRetry("Holdsport couldn't be reached.", "network");
    default: return e.status && e.status >= 500 ? willRetry(e.message, "serverError") : willRetry(e.message, "httpOther");
  }
}

/** Who the login is to the person connecting: a child (family graph, unless it is their own name) or themself. */
export function relationFor(ctx: Pick<RunContext<SportsConfig>, "viewer" | "config">, loginName: string | null): "self" | "child" {
  if (ctx.config.sportsChildNodeId) return "child";
  if (ctx.viewer.graphKind !== "family") return "self";
  return loginName && ctx.viewer.name && normName(loginName) === normName(ctx.viewer.name) ? "self" : "child";
}

export async function syncHoldsport(ctx: RunContext<SportsConfig>, transport: Transport = guardedTransport()): Promise<void> {
  const user = ctx.secrets.holdsportUser ?? "", password = ctx.secrets.holdsportPassword ?? "";
  if (!user || !password) throw needsYou("Type the Holdsport user name and password.", "holdsportAuth");
  const api = new HoldsportApi({ transport, user, password, base: holdsportBase(ctx.config.apiBase), throttle: () => ctx.throttle(), signal: ctx.signal });
  const allTeams = teamsFrom(await api.teams());
  const me = userFrom(await api.me());
  // Only the chosen teams are read at all (fewer requests).
  const teams = pickTeams(allTeams, ctx.config.sportsTeams ?? []);
  const { from, to } = windowOf(ctx.now);
  const perTeam: HoldsportRead["perTeam"] = [];
  for (const t of teams) {
    const members = await api.members(t.id);
    perTeam.push({ teamId: t.id, member: findLoginMember(members, me, user.includes("@") ? user : null), activities: await api.activities(t.id, from, to) });
  }
  const read: HoldsportRead = { me, teams: allTeams, perTeam };
  const loginName = perTeam.find((p) => p.member)?.member?.name ?? me.name;
  let fallback: string | null = null;
  if (!loginName && ctx.config.sportsChildNodeId) fallback = (await gbrain.getNode(ctx.viewer, ctx.config.sportsChildNodeId).catch(() => null))?.label ?? null;
  else if (!loginName && ctx.viewer.graphKind !== "family") fallback = ctx.viewer.name ?? null;
  const snapshot = holdsportSnapshot(read, relationFor(ctx, loginName), fallback);
  if (!snapshot.members.length) ctx.log("Holdsport didn't say whose login this is; activities come in without a person. Pick whose activities they are in the settings.");
  await syncSports(ctx, snapshot, { webUrl: HOLDSPORT_WEB });
}

export const holdsportConnector: Connector<SportsConfig> = {
  manifest: holdsportManifest,
  check(_c, s) {
    if (!s.holdsportUser || !s.holdsportPassword) throw needsYou("Type the Holdsport user name and password.", "holdsportAuth");
  },
  describe() { return { feedHost: "holdsport.dk" }; },
  async sync(ctx) {
    try {
      await syncHoldsport(ctx);
    } catch (e) {
      throw asConnectorError(e);
    }
  },
};
