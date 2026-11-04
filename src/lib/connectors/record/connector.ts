/**
 * Record (the household's meeting recorder) as a preset of the MCP connector: "Record: meetings, transcripts and
 * people". Signs in with Record (OAuth 2.1, dynamic registration) or a pasted rk_ key, then each run:
 *   1. reads Record's tools (the catalog) and what they make possible (time lines, sound, people, updated_since);
 *   2. lists meetings: changed since the cursor when Record offers `updated_since`, otherwise newest first, skipping
 *      the ones already known unchanged;
 *   3. per new or changed meeting: the whole meeting (get_meeting) and its time line (get_meeting_timeline when there,
 *      else estimated from the transcript); stores one source (kind "recording", url = Record's link, externalId =
 *      record:<id>, documentDate = when it was recorded, the transcript as text) and its time line, in one commit with
 *      the cursor; then hands the source to the reading queue, which proposes the people, the meeting, its decisions
 *      and to-dos as a change set with receipts.
 * Record's words are data, never instructions.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { recordingTimelines, sources } from "@/db/schema";
import { reprocessSource } from "@/lib/ingest";
import type { McpClient } from "@/lib/mcp-client/client";
import type { McpToolInfo } from "@/lib/mcp-client/tools";
import { needsYou } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { Connector, RunContext } from "../types";
import { asConnectorError, checkMcp, clientFor, syncCatalog, withMcpErrors } from "../mcp/connector";
import { mcpConfig, mcpSecrets, type McpConfig } from "../mcp/config";
import { listFingerprint, meetingDetail, meetingsFromList, meetingToSource, speakersFrom, timelineFrom, timelineFromTranscript, type MeetingListItem, type Timeline } from "./mapping";

import { RECORD_MCP_URL } from "./constants";

export { RECORD_MCP_URL };

export const recordManifest = defineManifest({
  id: "record", version: "1", status: "official", icon: "mic",
  auth: { type: "oauth2" },
  config: mcpConfig,
  secrets: mcpSecrets,
  fields: [
    { key: "serverUrl", kind: "url", required: true, placeholder: RECORD_MCP_URL },
    { key: "apiKey", kind: "password", secret: true, placeholder: "rk_…" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "catalog", key: "name", cursor: "catalogAt", resetOn: [] },
    { name: "meetings", key: "id", cursor: "updatedSince or newest", resetOn: [410] },
  ],
  schedule: { everyMinutes: 30 },
  rateLimit: { perMinute: 60, backoff: "exponential" },
  maps: { catalog: "catalog", meetings: "recording" },
});

export type RecordCaps = { timeline: boolean; audio: boolean; people: boolean; person: boolean; updatedSince: boolean };

/** What Record's tools make possible (the new ones may not be there yet). */
export function capabilitiesOf(tools: Pick<McpToolInfo, "name" | "inputSchema">[]): RecordCaps {
  const has = (n: string) => tools.some((t) => t.name === n);
  const list = tools.find((t) => t.name === "list_meetings");
  const props = (list?.inputSchema?.properties ?? {}) as Record<string, unknown>;
  return { timeline: has("get_meeting_timeline"), audio: has("get_meeting_audio"), people: has("list_people"), person: has("get_person"), updatedSince: "updated_since" in props };
}

type MeetingsCursor = { updatedSince?: string | null; newest?: string | null; caps?: string };

/** What the cursor remembers of Record's abilities: when they grow (word times arrive), everything is looked at again. */
export const capsKey = (c: RecordCaps) => `${+c.timeline}${+c.audio}${+c.people}${+c.updatedSince}`;

const MAX_PER_RUN = 25;
const READY = /^(ready|klar)$/i;

/** Meetings to read this run: new ones and ones whose list entry changed, in the order the cursor moves. */
export function planMeetings(list: MeetingListItem[], known: Map<string, string>, mode: "updatedSince" | "newest", max = MAX_PER_RUN): { take: MeetingListItem[]; more: boolean; unchanged: number } {
  const changed = list.filter((m) => known.get(`record:${m.id}`) !== listFingerprint(m));
  const ordered = mode === "updatedSince"
    ? [...changed].sort((a, b) => (a.updatedAt ?? a.tookPlace ?? "").localeCompare(b.updatedAt ?? b.tookPlace ?? ""))
    : [...changed].sort((a, b) => (b.tookPlace ?? "").localeCompare(a.tookPlace ?? ""));
  return { take: ordered.slice(0, max), more: ordered.length > max, unchanged: list.length - changed.length };
}

async function listMeetings(ctx: RunContext<McpConfig>, client: McpClient, caps: RecordCaps): Promise<{ list: MeetingListItem[]; mode: "updatedSince" | "newest" }> {
  const cur = cursorOf<MeetingsCursor>(ctx.state(), "meetings") ?? {};
  await ctx.throttle();
  if (caps.updatedSince) {
    // A minute of overlap: a meeting changed at the cursor's own moment is read again, never missed (dedupe keeps one).
    const sameCaps = cur.caps === capsKey(caps);
    const since = cur.updatedSince && sameCaps ? new Date(Date.parse(cur.updatedSince) - 60_000).toISOString() : (ctx.config.since ?? null);
    const r = await client.callTool("list_meetings", { limit: 100, ...(since ? { updated_since: since } : {}) });
    if (r.isError) throw new Error(r.text || "Record couldn't list the meetings.");
    return { list: meetingsFromList(r.data), mode: "updatedSince" };
  }
  const r = await client.callTool("list_meetings", { limit: 100, ...(ctx.config.since ? { since: ctx.config.since } : {}) });
  if (r.isError) throw new Error(r.text || "Record couldn't list the meetings.");
  return { list: meetingsFromList(r.data), mode: "newest" };
}

/** Name → email from Record's people (when it offers list_people), so speakers can be matched by address. */
async function peopleEmails(client: McpClient, caps: RecordCaps, ctx: RunContext<McpConfig>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!caps.people) return out;
  try {
    await ctx.throttle();
    const r = await client.callTool("list_people", {});
    if (r.isError) return out;
    for (const p of speakersFrom((r.data as { people?: unknown })?.people)) if (p.email) out.set(p.name.toLowerCase(), p.email);
  } catch (e) {
    ctx.log(`Record's people couldn't be read: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

async function readMeeting(ctx: RunContext<McpConfig>, client: McpClient, caps: RecordCaps, m: MeetingListItem, emails: Map<string, string>) {
  await ctx.throttle();
  const r = await client.callTool("get_meeting", { id: m.id });
  if (r.isError) { ctx.log(`“${m.title}” couldn't be read: ${r.text.slice(0, 200)}`); return null; }
  const d = meetingDetail(r.data, m);
  if (!d) return null;
  let timeline: Timeline | null = null;
  if (caps.timeline) {
    await ctx.throttle();
    const t = await client.callTool("get_meeting_timeline", { id: m.id }).catch(() => null);
    if (t && !t.isError) timeline = timelineFrom(t.data);
  }
  timeline ??= timelineFromTranscript(d.transcript, d.durationMs, d.people);
  for (const sp of timeline.speakers) if (!sp.email) sp.email = emails.get(sp.name.toLowerCase()) ?? null;
  return { d, timeline };
}

export async function syncRecord(ctx: RunContext<McpConfig>, client: McpClient): Promise<void> {
  const tools = await syncCatalog(ctx, client);
  const caps = capabilitiesOf(tools);
  if (!tools.some((t) => t.name === "get_meeting") || !tools.some((t) => t.name === "list_meetings")) {
    ctx.log("This server doesn't offer Record's meeting tools (list_meetings, get_meeting), so no meetings were read.");
    return;
  }
  if (!caps.timeline) ctx.log("Record doesn't give word times yet (get_meeting_timeline), so each word's moment is estimated from the transcript.");
  if (!caps.audio) ctx.log("Record doesn't hand out the sound yet (get_meeting_audio): transcripts show without audio.");

  const { list, mode } = await listMeetings(ctx, client, caps);
  ctx.count("meetings", "fetched", list.length);
  const known = new Map<string, string>();
  const keys = list.map((m) => `record:${m.id}`);
  const existing = new Map<string, { id: string; meta: Record<string, unknown> }>();
  if (keys.length) {
    const rows = await db.select({ id: sources.id, externalId: sources.externalId, meta: sources.meta }).from(sources)
      .where(and(eq(sources.graphId, ctx.connection.graphId), eq(sources.connectionId, ctx.connection.id), inArray(sources.externalId, keys)));
    for (const r of rows) if (r.externalId) {
      existing.set(r.externalId, { id: r.id, meta: r.meta ?? {} });
      const timing = ((r.meta ?? {}).recording as { timing?: string } | undefined)?.timing;
      // Read before Record gave word times: read again now that it does.
      known.set(r.externalId, caps.timeline && timing === "estimated" ? "" : String((r.meta ?? {}).listFingerprint ?? ""));
    }
  }
  const plan = planMeetings(list, known, mode);
  if (plan.unchanged) ctx.count("meetings", "unchanged", plan.unchanged);
  const emails = plan.take.length ? await peopleEmails(client, caps, ctx) : new Map<string, string>();
  const cur = cursorOf<MeetingsCursor>(ctx.state(), "meetings") ?? {};
  // The abilities are remembered only once everything they call for has been read (else the next run reads all again).
  let cursor: MeetingsCursor = { ...cur, caps: plan.more ? cur.caps : capsKey(caps) };

  for (const m of plan.take) {
    if (ctx.signal.aborted) return;
    const got = await readMeeting(ctx, client, caps, m, emails);
    if (!got) { ctx.count("meetings", "skipped"); continue; }
    const row = meetingToSource(got.d, got.timeline, { listFingerprint: listFingerprint(m), server: ctx.config.serverUrl });
    const prev = existing.get(row.externalId);
    const changedText = !prev || prev.meta.fingerprint !== row.meta.fingerprint;
    const advance = mode === "updatedSince"
      ? { ...cursor, updatedSince: [cursor.updatedSince, m.updatedAt].filter(Boolean).sort().at(-1) ?? null }
      : { ...cursor, newest: [cursor.newest, m.tookPlace].filter(Boolean).sort().at(-1) ?? null };
    let sourceId = prev?.id ?? "";
    const fetchedAt = new Date();
    await ctx.commit("meetings", advance, async (tx) => {
      if (!prev) {
        const [ins] = await tx.insert(sources).values({
          householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id,
          kind: "recording", title: row.title, mime: "text/plain", textContent: row.textContent,
          meta: { ...row.meta, eventNodeId: randomUUID() }, status: "pending", visibility: ctx.config.visibility ?? "private",
          documentDate: row.documentDate, documentDatePrecision: row.documentDate ? "minute" : null,
          url: row.url, externalId: row.externalId, connectionId: ctx.connection.id, fetchedAt,
        }).returning({ id: sources.id });
        sourceId = ins.id;
      } else {
        await tx.update(sources).set({
          title: row.title, textContent: row.textContent, url: row.url, fetchedAt,
          meta: { ...prev.meta, ...row.meta, eventNodeId: prev.meta.eventNodeId ?? randomUUID() },
          documentDate: row.documentDate, documentDatePrecision: row.documentDate ? "minute" : null,
        }).where(eq(sources.id, prev.id));
      }
      const tl = { durationMs: got.timeline.durationMs, words: got.timeline.words, lines: got.timeline.lines, speakers: got.timeline.speakers, timing: got.timeline.timing, fetchedAt };
      await tx.insert(recordingTimelines).values({ sourceId, graphId: ctx.connection.graphId, ...tl })
        .onConflictDoUpdate({ target: recordingTimelines.sourceId, set: tl });
    });
    cursor = advance;
    ctx.count("meetings", prev ? "updated" : "added");
    // Read (and propose from) a meeting once its words are written down, and again when they change.
    const ready = !got.d.status || READY.test(got.d.status);
    if (changedText && ready) {
      await reprocessSource(ctx.viewer, sourceId).catch((e) => ctx.log(`“${row.title}” couldn't be queued for reading: ${e instanceof Error ? e.message : e}`));
      ctx.count("meetings", "proposed");
    } else if (!ready) {
      ctx.log(`“${row.title}” is still ${got.d.status?.toLowerCase() ?? "being written down"} in Record; it will be read when it's ready.`);
    }
  }
  if (plan.more) ctx.log(`More meetings are waiting; they come in the next runs.`);
  else if (!plan.take.length && cur.caps !== cursor.caps) await ctx.commit("meetings", cursor, async () => {});
}

export const recordConnector: Connector<McpConfig> = {
  manifest: recordManifest,
  check(c, s) {
    try {
      checkMcp(c, s);
    } catch (e) {
      throw asConnectorError(e);
    }
    if (c.authMode === "key" && s.apiKey && !/^rk_[A-Za-z0-9_-]{8,}$/.test(s.apiKey)) throw needsYou("A Record key starts with rk_. Make one in Record under API and AI tools.", "badKey");
  },
  describe(c) {
    try { return { feedHost: new URL(c.serverUrl).hostname }; } catch { return {}; }
  },
  sync: (ctx) => withMcpErrors(() => syncRecord(ctx, clientFor(ctx, { perMinute: recordManifest.rateLimit.perMinute }))),
};
