/**
 * The JSON batches the Slack connector keeps as library sources (pure, shared with src/lib/connectors/slack). Two
 * kinds: the workspace's members (one source per workspace, re-read when someone joins or changes), and one channel's
 * messages on one day (one source per channel per day, re-read when that day gets more messages).
 */
import { z } from "zod";

const text = (max: number) => z.string().max(max);

export const slackTeam = z.object({ id: text(40), name: text(200), domain: text(200).optional() });

export const slackMember = z.object({
  id: text(40),
  /** The full name, else the display name, else the handle. */
  name: text(200),
  displayName: text(200).optional(),
  email: text(320).optional(),
  title: text(300).optional(),
  tz: text(80).optional(),
});
export type SlackMember = z.infer<typeof slackMember>;

export const slackMessage = z.object({
  ts: text(40),
  /** When it was posted (ISO, from ts). */
  at: z.string().datetime({ offset: true }),
  userId: text(40).optional(),
  /** Who wrote it, as Slack names them (a bot or an app keeps its own name). */
  author: text(200),
  /** Plain text: mentions, channels and links already turned into words. */
  text: text(40_000),
  /** Replies in its thread, when the connector read them. */
  replies: z.array(z.object({ ts: text(40), at: z.string().datetime({ offset: true }), userId: text(40).optional(), author: text(200), text: text(40_000) })).max(500).default([]),
  files: z.array(text(300)).max(50).default([]),
});
export type SlackMessage = z.infer<typeof slackMessage>;

export const slackPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("members"), team: slackTeam, members: z.array(slackMember).max(20_000) }),
  z.object({
    kind: z.literal("channel"),
    team: slackTeam,
    channel: z.object({ id: text(40), name: text(200), type: z.enum(["public", "private", "im", "mpim"]) }),
    /** The day (UTC, YYYY-MM-DD) these messages were posted on. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    messages: z.array(slackMessage).max(5_000),
  }),
]);
export type SlackPayload = z.infer<typeof slackPayload>;
