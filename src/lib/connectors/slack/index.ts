/** Slack connector (server-only), with the household's own Slack app and the person's user token. */
import type { Connector, RunContext } from "../types";
import type { Api } from "../oauth/client";
import { apiBase } from "../oauth/providers";
import { apiFor } from "../oauth/session";
import { requireSignIn } from "../oauth/fields";
import { importPayload } from "@/lib/importers/server";
import { slackPages } from "./api";
import { channelName, channelType, displayName, type RawChannel, type RawUser } from "./map";
import { slackManifest, syncSlack, type ImportBatch, type SlackConfig } from "./connector";

/** Keep a batch as a source of the `slack` importer, in this connection's name and visibility. */
export function importerFor(ctx: RunContext<{ visibility?: "private" | "parents" | "household" }>, importerId: string): ImportBatch {
  return (b) => importPayload(ctx.viewer, importerId, {
    bytes: b.bytes, title: b.title, connectionId: ctx.connection.id, externalId: b.externalId,
    visibility: ctx.config.visibility ?? "private", sensitive: b.sensitive,
  });
}

export const slackConnector: Connector<SlackConfig> = {
  manifest: slackManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncSlack(ctx, {
    api: apiFor(ctx.connection, ctx.secrets, { signal: ctx.signal, throttle: ctx.throttle }),
    base: apiBase().slack,
    importBatch: importerFor(ctx, "slack"),
  }),
};

export type ChannelOption = { id: string; name: string; hint?: string };

/** The channels a person may choose in the connection's settings (direct messages only with the opt-in). */
export async function listSlackChannels(api: Api, directMessages: boolean): Promise<ChannelOption[]> {
  const base = apiBase().slack;
  const types = ["public_channel", "private_channel", ...(directMessages ? ["im", "mpim"] : [])].join(",");
  const [list, users] = await Promise.all([
    slackPages<{ channels?: RawChannel[] }, RawChannel>(api, base, "conversations.list", { types, exclude_archived: true, limit: 200 }, (b) => b.channels, 20),
    directMessages ? slackPages<{ members?: RawUser[] }, RawUser>(api, base, "users.list", { limit: 200 }, (b) => b.members, 25) : Promise.resolve({ items: [] as RawUser[] }),
  ]);
  const names = new Map(users.items.map((u) => [u.id, displayName(u) ?? u.id]));
  const handles = new Map(users.items.filter((u) => u.name).map((u) => [u.name!, displayName(u) ?? u.name!]));
  const order: Record<string, number> = { public: 0, private: 1, mpim: 2, im: 3 };
  return list.items
    // A public channel the person hasn't joined is still readable, but list theirs first.
    .map((c) => ({ c, type: channelType(c) }))
    .sort((a, b) => order[a.type] - order[b.type] || Number(!!b.c.is_member) - Number(!!a.c.is_member) || channelName(a.c, names, handles).localeCompare(channelName(b.c, names, handles)))
    .map(({ c, type }) => ({
      id: c.id,
      name: type === "im" || type === "mpim" ? channelName(c, names, handles) : `#${channelName(c, names, handles)}`,
      hint: type,
    }));
}
