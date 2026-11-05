/**
 * Slack's shapes turned into the importer's batches (pure). Slack's message markup becomes plain words:
 *   <@U123> → @Anna Hansen    <#C123|general> → #general    <!here> → @here    <https://x|label> → label (https://x)
 * Messages are grouped by the UTC day they were posted on: one source per channel per day.
 */
import type { SlackMember, SlackMessage, SlackPayload } from "@/lib/importers/slack/schema";

export type RawUser = {
  id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean; tz?: string;
  profile?: { real_name?: string; display_name?: string; email?: string; title?: string };
};

export type RawFile = { name?: string; title?: string };

export type RawMessage = {
  ts: string; type?: string; subtype?: string; user?: string; username?: string; bot_profile?: { name?: string };
  text?: string; thread_ts?: string; reply_count?: number; files?: RawFile[];
};

export type RawChannel = {
  id: string; name?: string; is_channel?: boolean; is_group?: boolean; is_im?: boolean; is_mpim?: boolean; is_private?: boolean;
  is_archived?: boolean; is_member?: boolean; user?: string;
};

export type ChannelType = "public" | "private" | "im" | "mpim";

/** Message kinds that say nothing (joins, leaves, renames …). */
const NOISE = new Set(["channel_join", "channel_leave", "group_join", "group_leave", "channel_name", "group_name", "channel_archive", "channel_unarchive", "pinned_item", "unpinned_item", "bot_add", "bot_remove", "huddle_thread", "sh_room_created"]);

export function isPerson(u: RawUser): boolean {
  return !u.deleted && !u.is_bot && !u.is_app_user && u.id !== "USLACKBOT";
}

export function displayName(u: RawUser | undefined): string | null {
  if (!u) return null;
  return (u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || "").trim() || null;
}

export function toMember(u: RawUser): SlackMember {
  const name = displayName(u) ?? u.id;
  const handle = (u.profile?.display_name || u.name || "").trim();
  return {
    id: u.id, name: name.slice(0, 200),
    ...(handle && handle !== name ? { displayName: handle.slice(0, 200) } : {}),
    ...(u.profile?.email ? { email: u.profile.email.slice(0, 320) } : {}),
    ...(u.profile?.title ? { title: u.profile.title.slice(0, 300) } : {}),
    ...(u.tz ? { tz: u.tz.slice(0, 80) } : {}),
  };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** Slack markup → plain text, with people and channels by name. */
export function plainText(text: string, names: Map<string, string>, channels: Map<string, string> = new Map()): string {
  const out = text.replace(/<([^<>]+)>/g, (_all, inner: string) => {
    const [target, label] = inner.split("|", 2) as [string, string | undefined];
    if (target.startsWith("@")) { const id = target.slice(1); return `@${label ?? names.get(id) ?? id}`; }
    if (target.startsWith("#")) { const id = target.slice(1); return `#${label ?? channels.get(id) ?? id}`; }
    if (target.startsWith("!subteam^")) return label ?? "@team";
    if (target.startsWith("!date^")) return label ?? "";
    if (target.startsWith("!")) return `@${target.slice(1)}`;
    if (target.startsWith("mailto:")) return label ?? target.slice(7);
    return label && label !== target ? `${label} (${target})` : target;
  });
  return out.replace(/&(amp|lt|gt);/g, (e) => ENTITIES[e] ?? e);
}

/** A Slack ts ("1730716800.123456") as an ISO time. */
export function tsToIso(ts: string): string {
  const ms = Math.round(Number(ts) * 1000);
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

export const dayOf = (ts: string) => tsToIso(ts).slice(0, 10);

/** Midnight UTC of the day `sec` falls on, in seconds. */
export const startOfUtcDay = (sec: number) => Math.floor(sec / 86_400) * 86_400;

export function authorOf(m: RawMessage, names: Map<string, string>): string {
  if (m.user && names.has(m.user)) return names.get(m.user)!;
  return (m.bot_profile?.name || m.username || m.user || "Someone").slice(0, 200);
}

export function keep(m: RawMessage): boolean {
  if (m.subtype && NOISE.has(m.subtype)) return false;
  return !!(m.text?.trim() || m.files?.length);
}

export function toMessage(m: RawMessage, names: Map<string, string>, channels: Map<string, string>, replies: RawMessage[] = []): SlackMessage {
  return {
    ts: m.ts, at: tsToIso(m.ts), ...(m.user ? { userId: m.user } : {}), author: authorOf(m, names),
    text: plainText(m.text ?? "", names, channels).slice(0, 40_000),
    files: (m.files ?? []).map((f) => (f.title || f.name || "file").slice(0, 300)).slice(0, 50),
    replies: replies.filter((r) => r.ts !== m.ts && keep(r)).map((r) => ({
      ts: r.ts, at: tsToIso(r.ts), ...(r.user ? { userId: r.user } : {}), author: authorOf(r, names), text: plainText(r.text ?? "", names, channels).slice(0, 40_000),
    })).slice(0, 500),
  };
}

export function channelType(c: RawChannel): ChannelType {
  if (c.is_im) return "im";
  if (c.is_mpim) return "mpim";
  return c.is_private || c.is_group ? "private" : "public";
}

/** A human name for a channel: "general", or the other people in a direct message. */
export function channelName(c: RawChannel, names: Map<string, string>, handles: Map<string, string> = new Map()): string {
  if (c.is_im) return (c.user && names.get(c.user)) || c.user || "direct message";
  if (c.is_mpim && c.name) {
    const parts = c.name.replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").filter(Boolean);
    return parts.map((h) => handles.get(h) ?? h).join(", ");
  }
  return c.name ?? c.id;
}

/** Messages of one channel, grouped into one batch per UTC day (oldest day first). */
export function dayBatches(
  team: { id: string; name: string; domain?: string },
  channel: { id: string; name: string; type: ChannelType },
  messages: SlackMessage[],
): Extract<SlackPayload, { kind: "channel" }>[] {
  const byDay = new Map<string, SlackMessage[]>();
  for (const m of messages) {
    const d = m.at.slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(m);
  }
  return [...byDay.keys()].sort().map((day) => ({
    kind: "channel" as const, team, channel, day,
    messages: byDay.get(day)!.sort((a, b) => Number(a.ts) - Number(b.ts)),
  }));
}

/** The same batch always gives the same bytes, so an unchanged day is recognised and not read again. */
export function batchBytes(p: SlackPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(p));
}

/** The team's domain from auth.test's url ("https://acme.slack.com/" → "acme"). */
export function domainOf(url: string | undefined): string | undefined {
  const m = (url ?? "").match(/^https:\/\/([a-z0-9-]+)\.slack\.com\/?$/i);
  return m ? m[1].toLowerCase() : undefined;
}
