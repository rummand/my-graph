/**
 * My Graph for Mac: the pure settings and cursor logic, the helper's pure parts (imported from the exact text the
 * server serves), its reader against a tiny chat.db built with the sqlite3 tool, and a whole helper run (pair, list,
 * send, send again, backfill) against a fake My Graph that checks every batch against the importer's schema.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appleNotesPayload, imessagePayload } from "@/lib/importers/schemas";
import type { ImportKnown } from "@/lib/importers/types";
import { validateManifest, type Manifest } from "../manifest";
import {
  batchEnvelope, batchTitle, bearerToken, catalogBody, chatHasKnownPerson, cleanDevice, filterChats, filterNotes, helperSettings, macConfig,
  messagesCursor, newHelperToken, newPairingCode, nextMessagesCursor, nextNotesCursor, normaliseCode, notesCursor, pairingHash, sinceIso, tokenHash,
  type HelperSettings, type MacConfig, type MessagesCursor,
} from "./config";
import { macManifest } from "./connector";
import { helperSource } from "./helper/script";

type Helper = Record<string, any>;

const dir = mkdtempSync(join(tmpdir(), "mg-mac-test-"));
const scriptPath = join(dir, "my-graph-mac.mjs");
let H: Helper;

beforeAll(async () => {
  writeFileSync(scriptPath, helperSource("http://127.0.0.1:1", "en"));
  H = await import(pathToFileURL(scriptPath).href);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const person = (id: string, label: string, props: Record<string, unknown> = {}): ImportKnown => ({ id, type: "person", kind: null, label, aliases: [], startAt: null, props });

describe("settings and tokens", () => {
  it("is private and sends nothing until the person chooses", () => {
    const c = macConfig.parse({});
    expect(c.visibility).toBe("private");
    expect(c.messages).toMatchObject({ enabled: false, scope: "chosen", chats: [] });
    expect(c.notes).toMatchObject({ enabled: false, folders: null });
    const s = helperSettings({ connectionId: "c", label: "Mac", config: c, people: [], messages: messagesCursor(null), notes: notesCursor(null), generations: { messages: 0, notes: 0 }, now: new Date() });
    expect(s.messages.enabled).toBe(false);
    expect(s.messages.chats).toEqual([]);
    expect(s.notes.enabled).toBe(false);
  });

  it("has a valid manifest", () => {
    expect(validateManifest(macManifest as unknown as Manifest)).toEqual({ ok: true });
  });

  it("makes pairing codes that survive retyping and tokens only we accept", () => {
    const code = newPairingCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    expect(pairingHash(code.toLowerCase().replace("-", " "))).toBe(pairingHash(code));
    expect(normaliseCode(" ab-cd ")).toBe("ABCD");
    const tok = newHelperToken();
    expect(bearerToken(`Bearer ${tok}`)).toBe(tok);
    expect(bearerToken(`bearer   ${tok}  `)).toBe(tok);
    expect(bearerToken("Bearer mgm_short")).toBeNull();
    expect(bearerToken(`Basic ${tok}`)).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(tokenHash(tok)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(tok)).not.toBe(tokenHash(newHelperToken()));
  });

  it("finds conversations with people already in the graph (phone, email, unique name)", () => {
    const people = [person("p1", "Ida Hansen", { phone: "+45 12 34 56 78" }), person("p2", "Bo", { email: "bo@example.com" }), person("p3", "Mette Lund")];
    expect(chatHasKnownPerson({ participants: [{ handle: "12345678" }] }, people)).toBe(true);
    expect(chatHasKnownPerson({ participants: [{ handle: "BO@example.com" }] }, people)).toBe(true);
    expect(chatHasKnownPerson({ participants: [{ handle: "+4599999999", name: "Mette Lund" }] }, people)).toBe(true);
    expect(chatHasKnownPerson({ participants: [{ handle: "+4599999999", name: "Someone Else" }] }, people)).toBe(false);

    const cfg = macConfig.parse({
      messages: { enabled: true, scope: "known" },
      catalog: { at: "2026-11-01T00:00:00Z", folders: [], chats: [
        { id: "A", participants: [{ handle: "+4512345678" }], count: 3 },
        { id: "B", participants: [{ handle: "+4511111111" }], count: 3 },
      ] },
    });
    const s = helperSettings({ connectionId: "c", label: "Mac", config: cfg, people, messages: messagesCursor(null), notes: notesCursor(null), generations: { messages: 0, notes: 0 }, now: new Date() });
    expect(s.messages.chats).toEqual(["A"]);
  });

  it("backfills only conversations chosen after the first send", () => {
    const cfg: MacConfig = macConfig.parse({ messages: { enabled: true, chats: ["A", "B"], since: "all" } });
    const first = helperSettings({ connectionId: "c", label: "Mac", config: cfg, people: [], messages: { rowId: null, sentChats: [] }, notes: { updatedAt: null }, generations: { messages: 0, notes: 0 }, now: new Date() });
    expect(first.messages).toMatchObject({ chats: ["A", "B"], backfill: [], cursor: null, since: null });
    const later = helperSettings({ connectionId: "c", label: "Mac", config: cfg, people: [], messages: { rowId: 40, sentChats: ["A"] }, notes: { updatedAt: null }, generations: { messages: 0, notes: 0 }, now: new Date() });
    expect(later.messages).toMatchObject({ backfill: ["B"], cursor: 40 });
  });

  it("moves the cursors only as far as the helper got", () => {
    let c: MessagesCursor = { rowId: null, sentChats: [] };
    c = nextMessagesCursor(c, { phase: "forward", lastRowId: 10, final: false }, ["A"]);
    expect(c).toEqual({ rowId: 10, sentChats: [] });
    c = nextMessagesCursor(c, { phase: "backfill", lastRowId: 99, final: false }, ["A"]);
    expect(c.rowId).toBe(10);
    c = nextMessagesCursor(c, { phase: "forward", lastRowId: 20, final: true, covered: ["A", "Z"] }, ["A"]);
    expect(c).toEqual({ rowId: 20, sentChats: ["A"] });
    c = nextMessagesCursor(c, { phase: "forward", lastRowId: 5, final: true, covered: [] }, ["A"]);
    expect(c.rowId).toBe(20);
    expect(nextNotesCursor({ updatedAt: "2026-01-02T00:00:00.000Z" }, { final: true, notesCursor: "2026-01-01T00:00:00.000Z" }).updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(nextNotesCursor({ updatedAt: null }, { final: false, notesCursor: "2026-01-01T00:00:00.000Z" }).updatedAt).toBeNull();
    expect(nextNotesCursor({ updatedAt: null }, { final: true, notesCursor: "2026-01-01T00:00:00.000Z" }).updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(messagesCursor({ rowId: -3, sentChats: ["a", 4] })).toEqual({ rowId: null, sentChats: ["a"] });
  });

  it("drops anything the person didn't choose", () => {
    const p = { chats: [{ id: "A", participants: [], messages: [] }, { id: "B", participants: [], messages: [] }] };
    expect(filterChats(p, ["B"])).toEqual({ payload: { chats: [p.chats[1]] }, dropped: 1 });
    const n = { notes: [{ id: "1", title: "a", text: "", folder: "Family" }, { id: "2", title: "b", text: "", folder: "Work" }, { id: "3", title: "c", text: "" }] };
    expect(filterNotes(n, null).dropped).toBe(0);
    expect(filterNotes(n, ["Family"]).payload.notes.map((x) => x.id)).toEqual(["1"]);
  });

  it("titles, devices, windows and envelopes", () => {
    expect(batchTitle("imessage", { messages: 1, chats: 1 }, "Ida's Mac")).toBe("Messages from Ida's Mac: 1 message in 1 conversation");
    expect(batchTitle("apple_notes", { notes: 3 }, null)).toBe("Notes from your Mac: 3 notes");
    expect(cleanDevice("Idas-MacBook-Air.local")).toBe("Idas-MacBook-Air");
    expect(cleanDevice("<x>\u0001")).toBe("x");
    expect(sinceIso("all", new Date())).toBeNull();
    expect(Date.parse(sinceIso("3m", new Date("2026-11-05T00:00:00Z"))!)).toBe(Date.parse("2026-08-05T00:00:00Z"));
    expect(batchEnvelope.safeParse({ runId: crypto.randomUUID(), batch: "f-1-2", data: {} }).success).toBe(true);
    expect(batchEnvelope.safeParse({ runId: crypto.randomUUID(), batch: "../x y", data: {} }).success).toBe(false);
    expect(catalogBody.safeParse({ chats: [], folders: [], extra: 1 }).success).toBe(false);
  });
});

/* ── The helper's pure parts ─────────────────────────────────────────────────────────────────────────── */

/** A typedstream attributedBody as Messages writes it, holding `text`. */
function attributedBody(text: string): Buffer {
  const t = Buffer.from(text, "utf8");
  const len = t.length < 0x80 ? Buffer.from([t.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([t.length & 0xff, t.length >> 8])]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped", "latin1"), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from("NSAttributedString", "latin1"), Buffer.from([0x00, 0x84, 0x84, 0x08]), Buffer.from("NSObject", "latin1"),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]), Buffer.from("NSString", "latin1"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len, t, Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x05, 0x92, 0x84, 0x84, 0x84, 0x0c]), Buffer.from("NSDictionary", "latin1"), Buffer.from([0x00, 0x94, 0x84, 0x01, 0x69, 0x01]),
  ]);
}

describe("helper: pure parts", () => {
  it("converts Apple dates (nanoseconds and old seconds) both ways", () => {
    expect(H.appleToIso(0)).toBeNull();
    expect(H.appleToIso(1)).toBe("2001-01-01T00:00:01.000Z");
    // 2026-11-05T12:00:00Z
    const ns = (Date.parse("2026-11-05T12:00:00Z") - H.APPLE_EPOCH_MS) * 1e6;
    expect(H.appleToIso(ns)).toBe("2026-11-05T12:00:00.000Z");
    expect(H.appleToIso(String(ns))).toBe("2026-11-05T12:00:00.000Z");
    expect(H.appleToIso(Math.round(ns / 1e9))).toBe("2026-11-05T12:00:00.000Z");
    expect(H.isoToAppleNs("2026-11-05T12:00:00Z")).toBe((BigInt(Date.parse("2026-11-05T12:00:00Z") - H.APPLE_EPOCH_MS) * 1_000_000n).toString());
    expect(H.isoToAppleNs("nope")).toBeNull();
  });

  it("reads the text out of attributedBody", () => {
    expect(H.textFromAttributedBody(attributedBody("Hej, vi ses kl. 17 🎉"))).toBe("Hej, vi ses kl. 17 🎉");
    const long = "Æbler ".repeat(60).trim();
    expect(H.textFromAttributedBody(attributedBody(long).toString("hex"))).toBe(long);
    expect(H.textFromAttributedBody(Buffer.from("no class here"))).toBeNull();
    const full = attributedBody("a message that was cut short");
    expect(H.textFromAttributedBody(full.subarray(0, full.indexOf(Buffer.from("a message")) + 5))).toBeNull();
    expect(H.textFromAttributedBody(null)).toBeNull();
    expect(H.cleanText("￼  photo \r\n caption ")).toBe("photo \n caption");
  });

  it("batches messages under the size limit, each batch a contiguous run of ROWIDs", () => {
    const meta = (id: string) => ({ id, name: `Chat ${id}`, participants: [{ handle: "+4512345678" }] });
    const b = H.makeMessageBatcher({ maxBytes: 4000, chatMeta: meta });
    const out: any[] = [];
    for (let i = 1; i <= 60; i++) {
      const done = b.add(i % 3 === 0 ? "A" : "B", i, { id: `m${i}`, at: "2026-11-05T12:00:00.000Z", from: "me", text: "x".repeat(100), attachments: [] });
      if (done) out.push(done);
    }
    out.push(b.flush());
    expect(b.flush()).toBeNull();
    expect(out.length).toBeGreaterThan(1);
    let next = 1;
    for (const batch of out) {
      expect(Buffer.byteLength(JSON.stringify(batch.payload))).toBeLessThanOrEqual(4000);
      expect(batch.firstRowId).toBe(next);
      next = batch.lastRowId + 1;
      expect(imessagePayload.safeParse(batch.payload).success).toBe(true);
    }
    expect(next).toBe(61);
    expect(out.reduce((n, x) => n + x.count, 0)).toBe(60);
  });

  it("picks notes: allowed folders, not locked, not deleted, newer than the cursor", () => {
    const folders = [
      { id: "f1", name: "Family", notes: [
        { id: "n1", title: "Old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", locked: false },
        { id: "n2", title: "New", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", locked: false },
        { id: "n3", title: "Locked", updatedAt: "2026-04-01T00:00:00Z", locked: true },
      ] },
      { id: "f2", name: "Work", notes: [{ id: "n4", title: "W", updatedAt: "2026-05-01T00:00:00Z", locked: false }] },
      { id: "f3", name: "Recently Deleted", notes: [{ id: "n5", title: "Gone", updatedAt: "2026-06-01T00:00:00Z", locked: false }] },
    ];
    const all = H.pickNotes(folders, null, "2026-02-01T00:00:00Z");
    expect(all.pick.map((n: any) => n.id)).toEqual(["n2", "n4"]);
    expect(all.newest).toBe("2026-05-01T00:00:00.000Z");
    expect(H.pickNotes(folders, ["Family"], null).pick.map((n: any) => n.id)).toEqual(["n1", "n2"]);
    const batches = H.batchNotes([{ id: "1", title: "a", text: "y".repeat(3000) }, { id: "2", title: "b", text: "y".repeat(3000) }], 4000);
    expect(batches).toHaveLength(2);
    expect(appleNotesPayload.safeParse(batches[0]).success).toBe(true);
  });

  it("writes a launchd plist that macOS accepts", () => {
    const xml = H.launchdPlist({ label: "app.mygraph.mac", args: ["/usr/local/bin/node", "/Users/a & b/my-graph-mac.mjs", "send"], everyMinutes: 60, log: "/tmp/x.log", env: { MG_MAC_HOME: "/tmp/<h>" } });
    expect(xml).toContain("<integer>3600</integer>");
    expect(xml).toContain("/Users/a &amp; b/my-graph-mac.mjs");
    expect(xml).toContain("/tmp/&lt;h&gt;");
    if (existsSync("/usr/bin/plutil")) {
      const f = join(dir, "agent.plist");
      writeFileSync(f, xml);
      expect(() => execFileSync("/usr/bin/plutil", ["-lint", f])).not.toThrow();
    }
    expect(H.q("it's")).toBe("'it''s'");
  });

  it("is served with My Graph's address and without template literals", () => {
    const src = helperSource("https://graph.example.dk\"; evil()", "da");
    expect(src).toContain('const MY_GRAPH = "https://graph.example.dk; evil()";');
    expect(src).toContain('const LANG = "da";');
    expect(src).not.toContain("__MY_GRAPH_URL__");
  });
});

/* ── A tiny chat.db, and the helper run against a fake My Graph ──────────────────────────────────────── */

const hasSqlite = existsSync("/usr/bin/sqlite3");
const NS = (iso: string) => ((BigInt(Date.parse(iso)) - 978307200000n) * 1_000_000n).toString();

function makeChatDb(file: string) {
  const sql = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT, service_name TEXT, display_name TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB, handle_id INTEGER DEFAULT 0, date INTEGER, is_from_me INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, service TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
INSERT INTO handle (id, service) VALUES ('+4512345678', 'iMessage'), ('mette@example.com', 'iMessage'), ('+4587654321', 'SMS');
INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES
  ('iMessage;-;+4512345678', 45, '+4512345678', 'iMessage', ''),
  ('iMessage;+;chat123', 43, 'chat123', 'iMessage', 'Familien'),
  ('SMS;-;+4587654321', 45, '+4587654321', 'SMS', '');
INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2), (3, 3);
INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me, cache_has_attachments, associated_message_type) VALUES
  ('M1', 'Hej Ida, henter du Bo kl. 15?', NULL, 1, ${NS("2026-10-01T10:00:00Z")}, 1, 0, 0),
  ('M2', NULL, X'${attributedBody("Ja, og fodbold er flyttet til torsdag").toString("hex")}', 1, ${NS("2026-10-01T10:05:00Z")}, 0, 0, 0),
  ('M3', 'Loved "Ja"', NULL, 1, ${NS("2026-10-01T10:06:00Z")}, 1, 0, 2000),
  ('M4', '￼', NULL, 2, ${NS("2026-10-02T09:00:00Z")}, 0, 1, 0),
  ('M5', 'Farmor har fødselsdag 12. november', NULL, 2, ${NS("2026-10-03T09:00:00Z")}, 0, 0, 0),
  ('M6', 'Din kode er 123456', NULL, 3, ${NS("2026-10-04T09:00:00Z")}, 0, 0, 0);
INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2), (1, 3), (2, 4), (2, 5), (3, 6);
INSERT INTO attachment (guid, filename, mime_type, transfer_name) VALUES ('A1', '~/Library/Messages/Attachments/ab/IMG_0001.HEIC', 'image/heic', 'IMG_0001.HEIC');
INSERT INTO message_attachment_join VALUES (4, 1);
`;
  execFileSync("/usr/bin/sqlite3", [file], { input: sql });
}

describe.skipIf(!hasSqlite)("helper: reading a chat.db", () => {
  const db = join(dir, "chat.db");
  beforeAll(() => makeChatDb(db));

  it("lists conversations, newest first, without messages", async () => {
    const chats = await H.readCatalog(db, (h: string) => (h === "+4512345678" ? "Ida Hansen" : undefined), 500);
    expect(chats.map((c: any) => c.id)).toEqual(["SMS;-;+4587654321", "iMessage;+;chat123", "iMessage;-;+4512345678"]);
    const ida = chats.find((c: any) => c.id === "iMessage;-;+4512345678");
    expect(ida).toMatchObject({ name: "Ida Hansen", count: 3, participants: [{ handle: "+4512345678", name: "Ida Hansen" }] });
    expect(ida.lastAt).toBe("2026-10-01T10:06:00.000Z");
    expect(chats.find((c: any) => c.id === "iMessage;+;chat123").name).toBe("Familien");
    expect(JSON.stringify(chats)).not.toContain("fodbold");
  });

  it("reads only the chosen conversations, with attributedBody text, attachments, and no tapbacks", async () => {
    const got: any[] = [];
    const n = await H.readMessages(db, { chats: ["iMessage;-;+4512345678", "iMessage;+;chat123"], fromRowId: 0, toRowId: await H.maxRowId(db), pageSize: 2 }, (chat: string, rowId: number, m: any) => { got.push({ chat, rowId, ...m }); });
    expect(n).toBe(4);
    expect(got.map((m) => m.id)).toEqual(["M1", "M2", "M4", "M5"]);
    expect(got[0]).toMatchObject({ from: "me", at: "2026-10-01T10:00:00.000Z", text: "Hej Ida, henter du Bo kl. 15?" });
    expect(got[1]).toMatchObject({ from: "+4512345678", text: "Ja, og fodbold er flyttet til torsdag" });
    expect(got[2]).toMatchObject({ text: "", attachments: [{ filename: "IMG_0001.HEIC", mime: "image/heic" }] });
    expect(got.some((m) => m.text.includes("Din kode"))).toBe(false);
    const since: any[] = [];
    await H.readMessages(db, { chats: ["iMessage;+;chat123"], fromRowId: 0, toRowId: 6, sinceNs: H.isoToAppleNs("2026-10-03T00:00:00Z") }, (_c: string, _r: number, m: any) => { since.push(m.id); });
    expect(since).toEqual(["M5"]);
  });
});

/* A fake My Graph: the helper's three doors, with the real cursor logic and the importers' schemas. */
type Fake = { server: Server; url: string; batches: { importer: string; body: any }[]; cfg: MacConfig; state: { messages: MessagesCursor }; catalog: any; paired: boolean; token: string };

function startFake(): Promise<Fake> {
  const f: Fake = { server: null as unknown as Server, url: "", batches: [], cfg: macConfig.parse({}), state: { messages: { rowId: null, sentChats: [] } }, catalog: null, paired: false, token: newHelperToken() };
  const settings = (): HelperSettings => helperSettings({ connectionId: "conn-1", label: "My Graph for Mac", config: f.cfg, people: [], messages: f.state.messages, notes: { updatedAt: null }, generations: { messages: 0, notes: 0 }, now: new Date("2026-11-05T00:00:00Z") });
  const read = (req: IncomingMessage) => new Promise<any>((res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => res(s ? JSON.parse(s) : {})); });
  f.server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const body = req.method === "POST" ? await read(req) : null;
    if (req.url === "/api/connections/mac/pair") {
      if (body.pairingCode !== "ABCDE-FGHJK") return send(400, { error: "bad code" });
      f.paired = true;
      return send(200, { token: f.token, connectionId: "conn-1", label: "My Graph for Mac" });
    }
    if (bearerToken(req.headers.authorization) !== f.token) return send(401, { error: "unpaired" });
    if (req.url === "/api/connections/mac/settings") return send(200, settings());
    if (req.url === "/api/connections/mac/catalog") {
      const c = catalogBody.safeParse(body);
      if (!c.success) return send(400, { error: c.error.issues[0]?.message });
      f.catalog = c.data;
      return send(200, settings());
    }
    const m = /^\/api\/connections\/mac\/import\/(imessage|apple_notes)$/.exec(req.url ?? "");
    if (m) {
      const env = batchEnvelope.safeParse(body);
      if (!env.success) return send(400, { error: env.error.issues[0]?.message });
      const schema = m[1] === "imessage" ? imessagePayload : appleNotesPayload;
      const data = schema.safeParse(env.data.data);
      if (!data.success) return send(400, { error: data.error.issues[0]?.message });
      f.batches.push({ importer: m[1], body: env.data });
      if (m[1] === "imessage") f.state.messages = nextMessagesCursor(f.state.messages, env.data, settings().messages.chats);
      return send(201, { sourceId: "s", duplicate: false, kept: 0, dropped: 0 });
    }
    send(404, { error: "no" });
  });
  return new Promise((resolve) => f.server.listen(0, "127.0.0.1", () => { f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`; resolve(f); }));
}

function runHelper(args: string[], home: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [scriptPath, ...args, "--home", home, "--no-keychain", "--no-contacts"], { env: { ...process.env, MG_MAC_NO_KEYCHAIN: "1" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

describe.skipIf(!hasSqlite)("helper: a whole run against a fake My Graph", () => {
  const db = join(dir, "run-chat.db");
  const home = join(dir, "home");
  let f: Fake;
  beforeAll(async () => { makeChatDb(db); f = await startFake(); });
  afterAll(() => new Promise<void>((r) => f.server.close(() => r())));

  it("pairs, lists, sends only what is chosen, then only what is new, then backfills a newly chosen conversation", async () => {
    const common = ["--my-graph", f.url, "--chat-db", db];
    // 1. Pair; nothing chosen yet: only the list of conversations goes.
    let r = await runHelper(["--code", "ABCDE-FGHJK", ...common], home);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(f.token);
    expect(f.paired).toBe(true);
    expect(f.catalog.chats).toHaveLength(3);
    expect(JSON.stringify(f.catalog)).not.toContain("fodbold");
    expect(f.batches).toHaveLength(0);
    expect(r.out).toContain("Nothing is chosen yet");

    // 2. The person chooses one conversation: its messages go, nothing else.
    f.cfg = macConfig.parse({ messages: { enabled: true, chats: ["iMessage;-;+4512345678"], since: "all" } });
    r = await runHelper(common, home);
    expect(r.code, r.out).toBe(0);
    const sent = f.batches.flatMap((b) => b.body.data.chats ?? []);
    expect(sent.map((c: any) => c.id)).toEqual(["iMessage;-;+4512345678"]);
    expect(sent[0].messages.map((m: any) => m.text)).toEqual(["Hej Ida, henter du Bo kl. 15?", "Ja, og fodbold er flyttet til torsdag"]);
    expect(f.batches.at(-1)!.body).toMatchObject({ final: true, phase: "forward", lastRowId: 6 });
    expect(f.state.messages).toEqual({ rowId: 6, sentChats: ["iMessage;-;+4512345678"] });
    expect(r.out).toContain("Messages: sent 2 new messages from 1 conversation.");

    // 3. Again: nothing new, one empty final batch that keeps the cursor.
    f.batches = [];
    r = await runHelper(common, home);
    expect(r.code, r.out).toBe(0);
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0].body.data.chats).toEqual([]);

    // 4. A new message arrives and the family group is chosen too: the new message, and the group's history.
    execFileSync("/usr/bin/sqlite3", [db, `INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES ('M7', 'Tak!', 1, ${NS("2026-10-05T09:00:00Z")}, 0); INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 7);`]);
    f.cfg = macConfig.parse({ messages: { enabled: true, chats: ["iMessage;-;+4512345678", "iMessage;+;chat123"], since: "all" } });
    f.batches = [];
    r = await runHelper(common, home);
    expect(r.code, r.out).toBe(0);
    const backfill = f.batches.filter((b) => b.body.phase === "backfill").flatMap((b) => b.body.data.chats);
    const forward = f.batches.filter((b) => b.body.phase === "forward").flatMap((b) => b.body.data.chats);
    expect(backfill.map((c: any) => [c.id, c.messages.map((m: any) => m.id)])).toEqual([["iMessage;+;chat123", ["M4", "M5"]]]);
    expect(forward.map((c: any) => [c.id, c.messages.map((m: any) => m.id)])).toEqual([["iMessage;-;+4512345678", ["M7"]]]);
    expect(f.state.messages.rowId).toBe(7);
    expect(f.state.messages.sentChats.sort()).toEqual(["iMessage;+;chat123", "iMessage;-;+4512345678"]);
    expect(JSON.stringify(f.batches)).not.toContain("Din kode");

    // 5. Signed out in My Graph: the helper says so and forgets its key.
    f.token = newHelperToken();
    r = await runHelper(common, home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("doesn't know this helper any more");
  }, 60_000);
});
