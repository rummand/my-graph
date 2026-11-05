/**
 * Slack, read-only, with the person's own user token from the household's Slack app (see oauth/providers.ts).
 *
 *   members   users.list → one batch per workspace (the `slack` importer proposes the workspace as an organization
 *             and its members as people, matched by email). Unchanged lists give the same bytes and are not read again.
 *   messages  only the channels the person chose (direct and group messages only when they opted in at sign-in).
 *             conversations.history in windows of a week from the saved position, threads under their first message,
 *             one batch per channel per UTC day. Today's batch is read again next time, so a day that gets more
 *             messages is updated in place (same source), never duplicated. Cursor per channel: where the next
 *             window starts (midnight UTC) and the newest message seen.
 * Everything read is a library source; what it says is proposed as a change set a person delivers.
 */
import { z } from "zod";
import { needsYou } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import type { Api } from "../oauth/client";
import { account, oauthSecrets, sinceDay, sinceField, visibility } from "../oauth/fields";
import { SLACK_GRAPH_KINDS } from "@/lib/importers/slack";
import { slackCall, slackPages } from "./api";
import {
  batchBytes, channelName, channelType, dayBatches, displayName, domainOf, isPerson, keep, startOfUtcDay, toMember, toMessage,
  type RawChannel, type RawMessage, type RawUser,
} from "./map";

export const slackConfig = z.object({
  /** Channel ids the person chose (a typed "#general" is found by name too). Nothing is read until one is chosen. */
  channels: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** Direct and group messages: asked for at sign-in only when ticked (extra scopes), and stored as sensitive. */
  directMessages: z.boolean().default(false),
  since: sinceField,
  visibility,
  account,
});
export type SlackConfig = z.infer<typeof slackConfig>;

export const slackManifest = defineManifest({
  id: "slack", version: "1", status: "official", icon: "work",
  graphKinds: SLACK_GRAPH_KINDS,
  auth: { type: "oauth2" },
  config: slackConfig,
  secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [
    { name: "members", key: "user id", cursor: "when the member list was last read", resetOn: [] },
    { name: "messages", key: "channel + day", cursor: "next window start and newest ts, per channel", resetOn: [] },
  ],
  schedule: { everyMinutes: 60 },
  // conversations.history is Tier 3 (50/min), users.list Tier 2 (20/min): stay well under both.
  rateLimit: { perMinute: 20, backoff: "exponential" },
  maps: { members: "person", messages: "message" },
});

export type ImportBatch = (b: { bytes: Uint8Array; title: string; externalId: string; sensitive?: boolean }) => Promise<{ sourceId: string; duplicate: boolean }>;
export type SlackDeps = { api: Api; base: string; importBatch: ImportBatch };

export type SlackCursor = { channels?: Record<string, { from: number; latest?: string | null }> };

const WINDOW_DAYS = 7;
const WINDOWS_PER_RUN = 5;
const MAX_HISTORY_PAGES = 25;
const MAX_THREADS = 30;

type Team = { id: string; name: string; domain?: string };
type Lookup = { names: Map<string, string>; handles: Map<string, string>; channelNames: Map<string, string> };

export async function syncSlack(ctx: RunContext<SlackConfig>, d: SlackDeps): Promise<void> {
  const who = await slackCall<{ team?: string; team_id?: string; url?: string }>(d.api, d.base, "auth.test", {});
  if (!who.ok) throw needsYou("Slack didn't say which workspace this is. Sign in again.", "signInAgain");
  const team: Team = { id: who.data.team_id ?? "workspace", name: who.data.team ?? "Slack", ...(domainOf(who.data.url) ? { domain: domainOf(who.data.url) } : {}) };

  // Members: names for the messages, and the workspace's people for the graph.
  const users = await slackPages<{ members?: RawUser[] }, RawUser>(d.api, d.base, "users.list", { limit: 200 }, (b) => b.members, 25);
  const names = new Map(users.items.map((u) => [u.id, displayName(u) ?? u.id]));
  const handles = new Map(users.items.filter((u) => u.name).map((u) => [u.name!, displayName(u) ?? u.name!]));
  const people = users.items.filter(isPerson).map(toMember).sort((a, b) => a.id.localeCompare(b.id));
  ctx.count("members", "fetched", people.length);
  if (people.length) {
    const r = await d.importBatch({ bytes: batchBytes({ kind: "members", team, members: people }), title: `Slack members: ${team.name}`, externalId: `slack:${team.id}:members` });
    ctx.count("members", r.duplicate ? "unchanged" : "added");
  }
  await ctx.commit("members", { at: ctx.now.toISOString(), count: people.length }, async () => {});

  if (!ctx.config.channels.length) {
    ctx.log("No channel is chosen yet. Open the connection and choose the channels My Graph may read.");
    return;
  }
  const dms = ctx.config.directMessages;
  const types = ["public_channel", "private_channel", ...(dms ? ["im", "mpim"] : [])].join(",");
  const list = await slackPages<{ channels?: RawChannel[] }, RawChannel>(d.api, d.base, "conversations.list", { types, exclude_archived: true, limit: 200 }, (b) => b.channels, 20);
  const byId = new Map(list.items.map((c) => [c.id, c]));
  const byName = new Map(list.items.filter((c) => c.name && !c.is_im && !c.is_mpim).map((c) => [c.name!.toLowerCase(), c]));
  const look: Lookup = { names, handles, channelNames: new Map(list.items.filter((c) => c.name && !c.is_im && !c.is_mpim).map((c) => [c.id, c.name!])) };

  for (const wanted of ctx.config.channels) {
    const c = byId.get(wanted) ?? byName.get(wanted.replace(/^#/, "").toLowerCase());
    if (!c) { ctx.log(`"${wanted}" isn't a channel this Slack sign-in can see (archived, left, or a direct message without the opt-in). Choose it again.`); ctx.count("messages", "skipped"); continue; }
    const type = channelType(c);
    if ((type === "im" || type === "mpim") && !dms) { ctx.log("Direct messages are only read when you allowed them at sign-in."); continue; }
    await readChannel(ctx, d, team, c, look);
  }
}

async function readChannel(ctx: RunContext<SlackConfig>, d: SlackDeps, team: Team, c: RawChannel, look: Lookup): Promise<void> {
  const type = channelType(c);
  const name = channelName(c, look.names, look.handles);
  const label = type === "im" || type === "mpim" ? name : `#${name}`;
  const nowSec = Math.floor(ctx.now.getTime() / 1000);
  for (let w = 0; w < WINDOWS_PER_RUN; w++) {
    const cur = cursorOf<SlackCursor>(ctx.state(), "messages") ?? {};
    const saved = cur.channels?.[c.id];
    const from = saved?.from ?? startOfUtcDay(Math.floor(sinceDay(ctx.config.since, ctx.now).getTime() / 1000));
    if (from > nowSec) return;
    const end = from + WINDOW_DAYS * 86_400;
    const readTo = Math.min(end, nowSec);
    const h = await slackPages<{ messages?: RawMessage[] }, RawMessage>(d.api, d.base, "conversations.history",
      { channel: c.id, oldest: `${from}.000000`, latest: `${readTo}.999999`, inclusive: true, limit: 200 }, (b) => b.messages, MAX_HISTORY_PAGES);
    if (h.error) { ctx.log(`Slack wouldn't show ${label} (${h.error.replace(/_/g, " ")}); it was skipped.`); ctx.count("messages", "skipped"); return; }
    if (!h.complete) ctx.log(`${label} is very busy; the oldest messages of that week were left out.`);
    const kept = h.items.filter(keep);
    let threads = 0;
    const out = [];
    for (const m of kept) {
      let replies: RawMessage[] = [];
      if ((m.reply_count ?? 0) > 0 && (!m.thread_ts || m.thread_ts === m.ts) && threads < MAX_THREADS) {
        threads++;
        const r = await slackPages<{ messages?: RawMessage[] }, RawMessage>(d.api, d.base, "conversations.replies", { channel: c.id, ts: m.ts, limit: 200 }, (b) => b.messages, 5);
        replies = r.items;
      }
      // A reply also sent to the channel shows in both; keep it once, under its thread.
      if (m.subtype === "thread_broadcast" && m.thread_ts && m.thread_ts !== m.ts && kept.some((x) => x.ts === m.thread_ts)) continue;
      out.push(toMessage(m, look.names, look.channelNames, replies));
    }
    ctx.count("messages", "fetched", out.length);
    const sensitive = type === "im" || type === "mpim";
    for (const batch of dayBatches(team, { id: c.id, name, type }, out)) {
      const r = await d.importBatch({ bytes: batchBytes(batch), title: `Slack ${label}, ${batch.day}`, externalId: `slack:${team.id}:${c.id}:${batch.day}`, sensitive });
      ctx.count("messages", r.duplicate ? "unchanged" : "added");
    }
    const newest = kept.reduce<string | null>((a, m) => (!a || Number(m.ts) > Number(a) ? m.ts : a), saved?.latest ?? null);
    // A finished week moves on to the next; the week with today in it starts again at today's midnight.
    const next = end <= nowSec ? end : startOfUtcDay(nowSec);
    await ctx.commit("messages", { channels: { ...(cur.channels ?? {}), [c.id]: { from: next, latest: newest } } } satisfies SlackCursor, async () => {});
    if (end > nowSec) return;
  }
}
