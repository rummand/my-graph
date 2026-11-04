/**
 * A mailbox over IMAP (host, port, user name, app password, folders, since). Read-only: folders are opened with
 * EXAMINE, so nothing is ever marked as read, moved or deleted. Per folder the cursor is UIDVALIDITY + the last UID
 * stored; a changed UIDVALIDITY sends the stream down the reset path. Each message is stored unchanged as an email
 * source (kind email, message/rfc822, with its thread key, Message-ID as externalId, connectionId and fetchedAt) and
 * handed to the ingest library, which reads it, files it in its conversation and proposes what it finds.
 * The mail server's address is checked against the SSRF guard and the connection goes to that checked address.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { reprocessSource } from "@/lib/ingest";
import { parseEmail } from "@/lib/ingest/email";
import { resolveThreads, threadKeyFor } from "@/lib/ingest/mail";
import { putFile, sha256Hex } from "@/lib/storage";
import { CursorExpired, needsYou } from "../errors";
import { defineManifest } from "../manifest";
import { assertPublicHost, resolvePublic } from "../ssrf";
import { cursorOf } from "../state";
import type { Connector, RunContext } from "../types";
import { advance, batches, imapExternalId, newUids, planFolder, sinceDate, type FolderCursor } from "./cursor";

export const imapConfig = z.object({
  host: z.string().trim().min(3, "Enter the mail server, like imap.gmail.com.").max(253),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().trim().min(1, "Enter the user name (usually your email address).").max(320),
  folders: z.array(z.string().trim().min(1).max(200)).min(1).max(10).default(["INBOX"]),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date.").optional(),
  visibility: z.enum(["private", "parents", "household"]).default("private"),
});
export type ImapConfig = z.infer<typeof imapConfig>;

export const imapManifest = defineManifest({
  id: "imap", version: "1", status: "official", icon: "mail",
  auth: { type: "app_password" },
  config: imapConfig,
  secrets: z.object({ password: z.string().min(1, "Enter the app password.").max(500) }),
  fields: [
    { key: "host", kind: "text", required: true, placeholder: "imap.gmail.com" },
    { key: "port", kind: "number", placeholder: "993" },
    { key: "user", kind: "text", required: true, placeholder: "you@example.com" },
    { key: "password", kind: "password", secret: true, required: true },
    { key: "folders", kind: "list", placeholder: "INBOX" },
    { key: "since", kind: "date" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [{ name: "mail", key: "messageId", cursor: "uidValidity+lastUid per folder", resetOn: ["uidvalidity"] }],
  schedule: { everyMinutes: 15 },
  rateLimit: { perMinute: 30, backoff: "exponential" },
  maps: { mail: "correspondence" },
});

/** The few mail-client calls we use, so tests can hand in a fake server. */
export type ImapLike = {
  connect(): Promise<void>;
  mailboxOpen(path: string, opts: { readOnly: true }): Promise<{ path: string; uidValidity: bigint | number | string; uidNext?: number; exists?: number }>;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false | undefined>;
  fetch(range: number[] | string, query: { uid: true; source: true; envelope: true; size: true }, opts: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer; size?: number; envelope?: { messageId?: string } }>;
  logout(): Promise<void>;
  close?(): void;
};

export type ImapFactory = (cfg: ImapConfig & { address: string; password: string }) => Promise<ImapLike>;

type MailCursor = { folders?: Record<string, FolderCursor> };

const MAX_PER_RUN = 300;
const BATCH = 20;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** The real client (imapflow), connected to the checked address with the server's name for TLS. */
export const realImap: ImapFactory = async (cfg) => {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: cfg.address, port: cfg.port, secure: cfg.secure,
    servername: cfg.host,
    tls: { servername: cfg.host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: cfg.user, pass: cfg.password },
    logger: false, emitLogs: false, disableAutoIdle: true, connectionTimeout: 30_000, greetingTimeout: 15_000, socketTimeout: 120_000,
    // STARTTLS on 143 must not silently fall back to plain text.
    doSTARTTLS: cfg.secure ? undefined : true,
  } as ConstructorParameters<typeof ImapFlow>[0]);
  client.on("error", () => { /* surfaced by the awaiting call */ });
  return client as unknown as ImapLike;
};

/** Sync with a given client factory (the tests pass a fake). */
export async function syncMail(ctx: RunContext<ImapConfig>, factory: ImapFactory): Promise<void> {
  const cfg = ctx.config;
  const address = await resolvePublic(cfg.host);
  const client = await factory({ ...cfg, address, password: ctx.secrets.password ?? "" });
  const onAbort = () => { try { client.close?.(); } catch { /* already closed */ } };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    let budget = MAX_PER_RUN;
    const saved = cursorOf<MailCursor>(ctx.state(), "mail") ?? {};
    let folders: Record<string, FolderCursor> = { ...(saved.folders ?? {}) };
    for (const folder of cfg.folders) {
      if (budget <= 0) { ctx.log("Stopped for now after 300 messages; the rest comes in the next runs."); break; }
      let box;
      try {
        box = await client.mailboxOpen(folder, { readOnly: true });
      } catch {
        ctx.log(`The folder "${folder}" couldn't be opened; check its name.`);
        ctx.count("mail", "skipped");
        continue;
      }
      const plan = planFolder(folders[folder], { uidValidity: box.uidValidity, uidNext: box.uidNext, exists: box.exists });
      if (plan.mode === "reset") throw new CursorExpired("mail", "uidvalidity");
      if (plan.mode === "nothing") continue;
      const found = plan.mode === "initial"
        ? await client.search({ since: sinceDate(cfg.since, ctx.now) }, { uid: true })
        : await client.search({ uid: `${plan.fromUid}:*` }, { uid: true });
      const lastUid = plan.mode === "incremental" ? plan.fromUid - 1 : 0;
      const { take, more } = newUids(found || [], lastUid, budget);
      ctx.count("mail", "fetched", take.length);
      if (!take.length) {
        // Nothing new, but a first look still records the folder so the next run is incremental.
        if (!folders[folder]) {
          folders = { ...folders, [folder]: { uidValidity: plan.uidValidity, lastUid: Math.max(0, (box.uidNext ?? 1) - 1) } };
          await ctx.commit("mail", { folders }, async () => {});
        }
        continue;
      }
      for (const batch of batches(take, BATCH)) {
        if (ctx.signal.aborted) return;
        await ctx.throttle();
        const msgs: { uid: number; raw: Buffer; messageId?: string }[] = [];
        for await (const m of client.fetch(batch, { uid: true, source: true, envelope: true, size: true }, { uid: true })) {
          if (!m.source || m.source.length > MAX_MESSAGE_BYTES) { ctx.count("mail", "skipped"); continue; }
          msgs.push({ uid: m.uid, raw: m.source, messageId: m.envelope?.messageId ?? undefined });
        }
        const created = await storeBatch(ctx, folder, plan.uidValidity, msgs, () => {
          folders = { ...folders, [folder]: advance(folders[folder], plan.uidValidity, batch) };
          return { folders };
        });
        budget -= batch.length;
        // The ingest library reads each new message (text, date, conversation, attachments) and proposes from it.
        for (const id of created) await reprocessSource(ctx.viewer, id).catch((e) => ctx.log(`A message couldn't be queued for reading: ${e instanceof Error ? e.message : e}`));
      }
      if (more) ctx.log(`"${folder}" has more messages; they come in the next runs.`);
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    await client.logout().catch(() => client.close?.());
  }
}

/** Store one batch of messages and the folder cursor in one transaction. Returns the new source ids. */
async function storeBatch(ctx: RunContext<ImapConfig>, folder: string, uidValidity: string, msgs: { uid: number; raw: Buffer; messageId?: string }[], nextCursor: () => unknown): Promise<string[]> {
  const parsed = msgs.map((m) => {
    const text = m.raw.toString("utf8");
    const e = parseEmail(text);
    const messageId = e.messageId ?? m.messageId?.replace(/^<|>$/g, "");
    return { ...m, e, messageId, externalId: imapExternalId(messageId, folder, uidValidity, m.uid) };
  });
  // Already here (from an earlier run, another folder, or an .mbox upload): the graph has one copy per Message-ID.
  const ids = parsed.map((p) => p.externalId);
  const dupRows = ids.length ? await db.select({ externalId: sources.externalId }).from(sources)
    .where(and(eq(sources.graphId, ctx.connection.graphId), inArray(sources.externalId, ids))) : [];
  const dups = new Set(dupRows.map((r) => r.externalId));
  // Replies join the thread of a message we already have, even when that message came in an earlier batch.
  const parents = [...new Set(parsed.flatMap((p) => [p.e.inReplyTo, ...p.e.references]).filter((x): x is string => !!x))];
  const parentRows = parents.length ? await db.select({ externalId: sources.externalId, threadKey: sources.threadKey }).from(sources)
    .where(and(eq(sources.graphId, ctx.connection.graphId), inArray(sources.externalId, parents))) : [];
  const parentThread = new Map(parentRows.map((r) => [r.externalId!, r.threadKey]));
  const local = resolveThreads(parsed.map((p) => p.e));

  // Files are content-addressed and written before the transaction (a crash leaves at most an unreferenced file).
  const fresh = parsed.filter((p) => !dups.has(p.externalId));
  const stored = new Map<number, Awaited<ReturnType<typeof putFile>>>();
  for (const p of fresh) stored.set(p.uid, await putFile(new Uint8Array(p.raw)));
  ctx.count("mail", "unchanged", parsed.length - fresh.length);

  const created: string[] = [];
  const fetchedAt = new Date();
  await ctx.commit("mail", nextCursor(), async (tx) => {
    const seenInBatch = new Set<string>();
    for (const p of fresh) {
      if (seenInBatch.has(p.externalId)) continue;
      seenInBatch.add(p.externalId);
      const f = stored.get(p.uid)!;
      const inherited = [p.e.inReplyTo, ...p.e.references].map((x) => (x ? parentThread.get(x) : null)).find(Boolean);
      const threadKey = inherited ?? (p.e.messageId ? local.get(p.e.messageId.toLowerCase()) : null) ?? threadKeyFor(p.e);
      const [row] = await tx.insert(sources).values({
        householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id, kind: "email",
        title: (p.e.subject?.trim() || "(no subject)").slice(0, 250), mime: "message/rfc822",
        storageKey: f.storageKey, sha256: f.sha256 ?? sha256Hex(new Uint8Array(p.raw)), size: f.size,
        meta: { originalName: `${ctx.connection.label}: ${folder}`, kind: "email", imap: { folder, uid: p.uid, uidValidity } },
        status: "pending", visibility: ctx.config.visibility ?? "private", sensitive: false,
        threadKey, externalId: p.externalId, documentDate: p.e.date ?? null, documentDatePrecision: p.e.date ? "minute" : null,
        connectionId: ctx.connection.id, fetchedAt, url: null,
      }).returning({ id: sources.id });
      created.push(row.id);
    }
  });
  ctx.count("mail", "added", created.length);
  return created;
}

export const imapConnector: Connector<ImapConfig> = {
  manifest: imapManifest,
  check(c, s) {
    assertPublicHost(c.host);
    if (!s.password) throw needsYou("Enter the app password.", "missingPassword");
  },
  describe(c) { return { feedHost: c.host.toLowerCase() }; },
  sync: (ctx) => syncMail(ctx, realImap),
};
