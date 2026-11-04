import { beforeEach, describe, expect, it, vi } from "vitest";

/* A fake database: SELECTs answer from `existing`, INSERTs record rows. */
const existing: { externalId: string; threadKey: string | null }[] = [];
const inserted: Record<string, unknown>[] = [];
const queued: string[] = [];
vi.mock("@/db", () => {
  const select = () => ({ from: () => ({ where: async () => existing.map((e) => ({ externalId: e.externalId, threadKey: e.threadKey })) }) });
  return { db: { select }, sql: {} };
});
vi.mock("@/lib/ingest", () => ({ reprocessSource: async (_v: unknown, id: string) => { queued.push(id); } }));
vi.mock("@/lib/storage", () => ({
  putFile: async (b: Uint8Array) => ({ sha256: `sha${b.length}`, storageKey: `key${b.length}`, size: b.length, existed: false }),
  sha256Hex: () => "sha",
}));

import { CursorExpired } from "../errors";
import { readState, withCursor, type ConnectionState } from "../state";
import type { RunContext, Tx } from "../types";
import { imapConfig, syncMail, type ImapFactory, type ImapLike } from "./connector";

const msg = (id: string, subject: string, extra = "") =>
  Buffer.from(`Message-ID: <${id}>\r\nSubject: ${subject}\r\nFrom: Bo <bo@skole.dk>\r\nDate: Mon, 2 Nov 2026 10:00:00 +0100\r\n${extra}\r\nHej\r\n`);

type Box = { uidValidity: number; messages: Map<number, Buffer> };

function fakeServer(boxes: Record<string, Box>, calls: string[]): ImapFactory {
  return async () => {
    let open: Box | null = null;
    const client: ImapLike = {
      async connect() { calls.push("connect"); },
      async mailboxOpen(path, opts) {
        calls.push(`open ${path} ro=${opts.readOnly}`);
        open = boxes[path];
        if (!open) throw new Error("no such folder");
        return { path, uidValidity: BigInt(open.uidValidity), uidNext: Math.max(0, ...open.messages.keys()) + 1, exists: open.messages.size };
      },
      async search(q) {
        calls.push(`search ${JSON.stringify(q)}`);
        const uids = [...open!.messages.keys()];
        if (typeof q.uid === "string") {
          const from = Number(q.uid.split(":")[0]);
          const hits = uids.filter((u) => u >= from);
          return hits.length ? hits : [Math.max(...uids)]; // the n:* quirk
        }
        return uids;
      },
      async *fetch(range) {
        calls.push(`fetch ${(range as number[]).join(",")}`);
        for (const uid of range as number[]) yield { uid, source: open!.messages.get(uid), envelope: {} };
      },
      async logout() { calls.push("logout"); },
    };
    return client;
  };
}

function makeCtx(state: ConnectionState) {
  let s = state;
  const counts: Record<string, Record<string, number>> = {};
  const commits: unknown[] = [];
  let n = 0;
  const tx = { insert: () => ({ values: (row: Record<string, unknown>) => ({ returning: async () => { inserted.push(row); return [{ id: `src${++n}` }]; } }) }) } as unknown as Tx;
  const ctx: RunContext<ReturnType<typeof imapConfig.parse>> = {
    viewer: { id: "u1", graphHouseholdId: "h1" } as RunContext["viewer"],
    connection: { id: "c1", graphId: "g1", userId: "u1", label: "Mail", connector: "imap" },
    runId: "r1", config: imapConfig.parse({ host: "93.184.216.34", user: "me@x.dk", folders: ["INBOX", "Skole"], since: "2026-09-01" }),
    secrets: { password: "pw" }, now: new Date("2026-11-04T12:00:00Z"), signal: new AbortController().signal,
    state: () => s,
    async commit(stream, cursor, write) { await write(tx); s = withCursor(s, stream, cursor); commits.push(cursor); },
    count(stream, key, k = 1) { (counts[stream] ??= {})[key] = (counts[stream][key] ?? 0) + k; },
    log() {}, proposed() {}, async throttle() {},
  };
  return { ctx, counts, commits, get state() { return s; } };
}

describe("IMAP sync with a fake server", () => {
  beforeEach(() => { existing.length = 0; inserted.length = 0; queued.length = 0; });

  it("first run reads since the date, read-only, and saves UIDVALIDITY + last UID per folder", async () => {
    const calls: string[] = [];
    const server = fakeServer({
      INBOX: { uidValidity: 7, messages: new Map([[3, msg("a@x", "Forældremøde")], [5, msg("b@x", "Re: Forældremøde", "In-Reply-To: <a@x>\r\n")]]) },
      Skole: { uidValidity: 9, messages: new Map([[1, msg("c@x", "Tur")]]) },
    }, calls);
    const t = makeCtx({});
    await syncMail(t.ctx, server);
    expect(calls.filter((c) => c.startsWith("open"))).toEqual(["open INBOX ro=true", "open Skole ro=true"]);
    expect(calls).toContain('search {"since":"2026-09-01T00:00:00.000Z"}');
    expect(t.state.streams!.mail.cursor).toEqual({ folders: { INBOX: { uidValidity: "7", lastUid: 5 }, Skole: { uidValidity: "9", lastUid: 1 } } });
    expect(inserted.map((r) => r.externalId)).toEqual(["a@x", "b@x", "c@x"]);
    expect(inserted[0]).toMatchObject({ kind: "email", mime: "message/rfc822", connectionId: "c1", graphId: "g1", ownerId: "u1" });
    expect(inserted[1].threadKey).toBe(inserted[0].threadKey); // the reply joins its thread
    expect(queued).toEqual(["src1", "src2", "src3"]);
    expect(calls.at(-1)).toBe("logout");
  });

  it("next run fetches only UIDs above the cursor and ignores the n:* quirk", async () => {
    const calls: string[] = [];
    const inbox: Box = { uidValidity: 7, messages: new Map([[3, msg("a@x", "A")], [5, msg("b@x", "B")]]) };
    const start = withCursor(readState({}), "mail", { folders: { INBOX: { uidValidity: "7", lastUid: 5 }, Skole: { uidValidity: "9", lastUid: 1 } } });
    const t = makeCtx(start);
    // Nothing new: UIDNEXT says so, no search at all.
    await syncMail(t.ctx, fakeServer({ INBOX: inbox, Skole: { uidValidity: 9, messages: new Map([[1, msg("c@x", "C")]]) } }, calls));
    expect(calls.some((c) => c.startsWith("search"))).toBe(false);
    expect(inserted).toHaveLength(0);
    inbox.messages.set(8, msg("d@x", "D"));
    await syncMail(t.ctx, fakeServer({ INBOX: inbox, Skole: { uidValidity: 9, messages: new Map([[1, msg("c@x", "C")]]) } }, calls));
    expect(calls).toContain('search {"uid":"6:*"}');
    expect(calls).toContain("fetch 8");
    expect(inserted.map((r) => r.externalId)).toEqual(["d@x"]);
    expect((t.state.streams!.mail.cursor as { folders: Record<string, { lastUid: number }> }).folders.INBOX.lastUid).toBe(8);
  });

  it("skips messages the graph already has (by Message-ID) but still moves the cursor", async () => {
    existing.push({ externalId: "a@x", threadKey: "mid:a@x" });
    const t = makeCtx({});
    await syncMail(t.ctx, fakeServer({ INBOX: { uidValidity: 7, messages: new Map([[3, msg("a@x", "A")]]) }, Skole: { uidValidity: 9, messages: new Map() } }, []));
    expect(inserted).toHaveLength(0);
    expect(t.counts.mail.unchanged).toBe(1);
    expect((t.state.streams!.mail.cursor as { folders: Record<string, { lastUid: number }> }).folders.INBOX.lastUid).toBe(3);
  });

  it("a changed UIDVALIDITY takes the reset path", async () => {
    const start = withCursor(readState({}), "mail", { folders: { INBOX: { uidValidity: "7", lastUid: 5 } } });
    const t = makeCtx(start);
    await expect(syncMail(t.ctx, fakeServer({ INBOX: { uidValidity: 8, messages: new Map([[1, msg("a@x", "A")]]) } }, []))).rejects.toBeInstanceOf(CursorExpired);
  });
});
