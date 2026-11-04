/**
 * Gmail, read-only (gmail.readonly), with the household's own Google app.
 *   First read: the mailbox's history id is noted FIRST (so nothing arriving meanwhile is missed), then the chosen
 *   labels are listed from the start date on (messages.list, page by page; the page is part of the cursor, so a long
 *   first read continues in the next run).
 *   After that: history.list from the saved history id (new messages, and messages given a chosen label). Gmail keeps
 *   history for about a week; a 404 means the saved id is too old: the one reset path reads again from the start date,
 *   and what is already stored is skipped (by Gmail's id before downloading, by Message-ID after).
 * Each message is fetched as the original (format=raw) and stored as an email source, threadKey from Gmail's threadId;
 * the reading queue saves its attachments as child sources. Nothing is ever marked read, labelled or deleted.
 */
import { z } from "zod";
import { CursorExpired } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected } from "../oauth/client";
import type { SyncDeps } from "../oauth/deps";
import { account, oauthSecrets, sinceDay, sinceField, visibility } from "../oauth/fields";
import type { MailItem } from "../oauth/sink";
import { gmailAfter, gmailPlan, gmailRaw, historyMessages, type GmailCursor, type GmailHistory } from "./map";

export const gmailConfig = z.object({
  /** Gmail label ids ("INBOX", "Label_12"). Empty = all mail except spam, trash and drafts. */
  labels: z.array(z.string().trim().min(1).max(200)).max(20).default(["INBOX"]),
  since: sinceField,
  visibility,
  account,
});
export type GmailConfig = z.infer<typeof gmailConfig>;

export const gmailManifest = defineManifest({
  id: "gmail", version: "1", status: "official", icon: "mail",
  auth: { type: "oauth2" },
  config: gmailConfig,
  secrets: oauthSecrets,
  fields: [
    { key: "labels", kind: "list", placeholder: "INBOX" },
    { key: "since", kind: "date" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [{ name: "mail", key: "messageId", cursor: "historyId (first read: label + page)", resetOn: [404] }],
  schedule: { everyMinutes: 15 },
  rateLimit: { perMinute: 600, backoff: "exponential" },
  maps: { mail: "correspondence" },
});

const MAX_PER_RUN = 200;
const BATCH = 20;
const MAX_RAW_BYTES = 40 * 1024 * 1024;

type Budget = { left: number };

async function fetchAndStore(ctx: RunContext<GmailConfig>, d: SyncDeps, ids: { id: string; threadId: string }[], cursorAfter: (i: number, last: boolean) => GmailCursor, budget: Budget, folder: string): Promise<boolean> {
  const known = await d.sink.knownMail(ctx as RunContext, ids.map((m) => `gmail:${m.id}`));
  const todo = ids.filter((m) => !known.has(`gmail:${m.id}`));
  ctx.count("mail", "unchanged", ids.length - todo.length);
  if (!todo.length) {
    await d.sink.cursor(ctx as RunContext, "mail", cursorAfter(ids.length, true));
    return true;
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    if (budget.left <= 0 || ctx.signal.aborted) return false;
    const slice = todo.slice(i, Math.min(i + BATCH, i + budget.left));
    const items: MailItem[] = [];
    for (const m of slice) {
      const r = await d.api({ url: `${d.base.gmail}/messages/${encodeURIComponent(m.id)}?format=raw`, maxBytes: MAX_RAW_BYTES });
      if (r.status === 404) { ctx.count("mail", "skipped"); continue; } // removed since it was listed
      if (r.status !== 200) throw unexpected(r, "Google", "a message");
      const b = bodyOf<{ raw?: string; threadId?: string; labelIds?: string[] }>(r, "Google");
      if (!b.raw) { ctx.count("mail", "skipped"); continue; }
      items.push({ raw: gmailRaw(b.raw), providerId: `gmail:${m.id}`, threadKey: `gmail:${b.threadId ?? m.threadId}`, folder, webUrl: `https://mail.google.com/mail/u/0/#all/${m.id}` });
    }
    ctx.count("mail", "fetched", items.length);
    budget.left -= slice.length;
    const last = i + slice.length >= todo.length;
    await d.sink.mail(ctx as RunContext, "mail", items, cursorAfter(i + slice.length, last), ctx.config.visibility ?? "private");
  }
  return true;
}

export async function syncGmail(ctx: RunContext<GmailConfig>, d: SyncDeps): Promise<void> {
  const wanted = ctx.config.labels ?? [];
  let cur = cursorOf<GmailCursor>(ctx.state(), "mail");
  const budget: Budget = { left: MAX_PER_RUN };

  if (gmailPlan(cur) === "start") {
    const r = await d.api({ url: `${d.base.gmail}/profile` });
    if (r.status !== 200) throw unexpected(r, "Google", "the mailbox");
    const p = bodyOf<{ historyId?: string; emailAddress?: string }>(r, "Google");
    if (!p.historyId) throw unexpected({ ...r, status: 502 }, "Google", "the mailbox's position");
    cur = { historyId: p.historyId, initial: { labelIndex: 0, pageToken: null, since: sinceDay(ctx.config.since, ctx.now).toISOString().slice(0, 10) } };
    await d.sink.cursor(ctx as RunContext, "mail", cur);
    ctx.log(`First read of the mailbox from ${cur.initial!.since}.`);
  }

  // First read: one label at a time, page by page.
  while (cur?.initial) {
    const labels = wanted.length ? wanted : [null];
    const init = cur.initial;
    if (init.labelIndex >= labels.length) { cur = { historyId: cur.historyId }; await d.sink.cursor(ctx as RunContext, "mail", cur); break; }
    const label = labels[init.labelIndex];
    const q = new URLSearchParams({ q: gmailAfter(new Date(`${init.since}T00:00:00Z`)), maxResults: "100", includeSpamTrash: "false" });
    if (label) q.set("labelIds", label);
    if (init.pageToken) q.set("pageToken", init.pageToken);
    const r = await d.api({ url: `${d.base.gmail}/messages?${q}` });
    if (r.status === 400 && init.pageToken) {
      // The page position expired: list this label again (what is stored is skipped).
      ctx.log("The saved page in the mailbox expired; listing that label again.");
      cur = { ...cur, initial: { ...init, pageToken: null } };
      continue;
    }
    if (r.status === 404 && label) {
      ctx.log(`The label "${label}" no longer exists in Gmail; it was skipped.`);
      cur = { ...cur, initial: { ...init, labelIndex: init.labelIndex + 1, pageToken: null } };
      await d.sink.cursor(ctx as RunContext, "mail", cur);
      continue;
    }
    if (r.status !== 200) throw unexpected(r, "Google", "the messages");
    const page = bodyOf<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(r, "Google");
    const ids = page.messages ?? [];
    const base = cur;
    const nextInit = page.nextPageToken
      ? { ...init, pageToken: page.nextPageToken }
      : { ...init, labelIndex: init.labelIndex + 1, pageToken: null };
    const done = await fetchAndStore(ctx, d, ids, (_i, last) => (last ? { ...base, initial: nextInit } : base), budget, label ?? "All mail");
    if (!done) { ctx.log("Stopped for now; the rest of the mailbox comes in the next runs."); return; }
    cur = { ...base, initial: nextInit };
  }

  // From the saved history id on.
  let pageToken: string | null = null;
  const start = cur!.historyId!;
  for (;;) {
    const q = new URLSearchParams({ startHistoryId: start, maxResults: "500" });
    q.append("historyTypes", "messageAdded");
    q.append("historyTypes", "labelAdded");
    if (pageToken) q.set("pageToken", pageToken);
    const r = await d.api({ url: `${d.base.gmail}/history?${q}` });
    if (r.status === 404) throw new CursorExpired("mail", 404);
    if (r.status !== 200) throw unexpected(r, "Google", "what changed in the mailbox");
    const page = bodyOf<GmailHistory>(r, "Google");
    const ids = historyMessages(page, wanted);
    const last = !page.nextPageToken;
    // The history id moves on only with the last page; until then a stop simply reads these pages again.
    const after: GmailCursor = last && page.historyId ? { historyId: page.historyId } : { historyId: start };
    const done = await fetchAndStore(ctx, d, ids, (_i, end) => (end ? after : { historyId: start }), budget, wanted.join(", ") || "All mail");
    if (!done) { ctx.log("Stopped for now; more new mail comes in the next run."); return; }
    if (last) return;
    pageToken = page.nextPageToken!;
  }
}
