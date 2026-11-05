/**
 * My Graph for Mac: one small Node script (no packages) the person downloads from /connections/mac and runs on their
 * own Mac. It reads Messages (~/Library/Messages/chat.db, with the sqlite3 tool that ships with macOS) and Apple Notes
 * (through osascript / JavaScript for Automation), and sends what the person chose to My Graph as JSON batches
 * (imessagePayload / appleNotesPayload). It only sends: everything it brings becomes library sources and proposals.
 *
 *   node my-graph-mac.mjs --code ABCDE-FGHJK   pair with the code from My Graph, then send
 *   node my-graph-mac.mjs                      send what is new (pairs first if needed)
 *   node my-graph-mac.mjs list                 show the conversations it can see (nothing is sent)
 *   node my-graph-mac.mjs schedule --every 60  run by itself (a launchd agent); `unschedule` stops it
 *   node my-graph-mac.mjs forget               remove the key and cursors from this Mac
 *
 * The helper token is kept in the macOS Keychain (or a 0600 file when the Keychain can't be used), never printed.
 * Kept here as text (served by /api/connections/mac/helper with My Graph's address filled in) so it works in a
 * standalone build. Plain JavaScript without template literals so it can live in this string. Its pure functions are
 * exported and tested (mac.test.ts imports the served text).
 */
export const HELPER_FILENAME = "my-graph-mac.mjs";

const SOURCE = String.raw`#!/usr/bin/env node
// My Graph for Mac: sends the Messages conversations and Notes you choose to My Graph.
// Run on your own Mac:  node my-graph-mac.mjs --code ABCDE-FGHJK
//
// What it does, and only this:
//   1. Reads the list of your conversations from Messages (names and numbers, no messages) and, if you turned Notes
//      on, the names of your Notes folders, and tells My Graph so you can choose there.
//   2. Sends only what you chose on the My Graph page: the messages of the conversations you picked, and the notes in
//      the folders you picked. Nothing is sent until you choose. Locked notes and Recently Deleted are never read.
//   3. Remembers where it got to (here and in My Graph), so the next run sends only what is new.
// It never changes, sends or deletes anything in Messages or Notes. In My Graph, what it brings waits for you to approve.
// Needs: macOS, Node 18 or newer, and Full Disk Access for the app you run it from (Terminal) to read Messages.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const MY_GRAPH = "__MY_GRAPH_URL__";
const LANG = "__LANG__";
export const HELPER_VERSION = "1";
const KEYCHAIN_SERVICE = "My Graph for Mac";
const AGENT_LABEL = "app.mygraph.mac";

const T = {
  en: {
    intro: "My Graph for Mac",
    askCode: "Pairing code from My Graph (like ABCDE-FGHJK): ",
    needCode: "This Mac isn't paired yet. Make a pairing code on My Graph (Connections, My Graph for Mac) and run:  node my-graph-mac.mjs --code ABCDE-FGHJK",
    pairing: "Pairing with My Graph…",
    paired: "Paired. This Mac sends to",
    http: "My Graph's address should start with https://. Stopping so nothing travels unencrypted.",
    fda: "Messages can't be read: give Full Disk Access to the app you run this from (Terminal, iTerm, or node for the schedule).\n  System Settings > Privacy & Security > Full Disk Access, switch it on, then quit and reopen that app and run this again.",
    fdaOpen: "Opening Full Disk Access in System Settings…",
    notesDenied: "Notes can't be read: allow the app you run this from to control Notes (System Settings > Privacy & Security > Automation), then run this again.",
    catalog: "Told My Graph about {chats} conversations and {folders} Notes folders (names only).",
    nothingChosen: "Nothing is chosen yet. Choose conversations and/or Notes on the My Graph page (Connections, My Graph for Mac), then run this again.",
    messagesOff: "Messages: off in My Graph.",
    notesOff: "Notes: off in My Graph.",
    messagesNone: "Messages: on, but no conversations are chosen yet.",
    sentMessages: "Messages: sent {n} new {messages} from {chats} {conversations}.",
    sentNotes: "Notes: sent {n} new or changed {notes}.",
    dry: "Dry run: nothing was sent.",
    wouldMessages: "Messages: would send {n} {messages} from {chats} {conversations} in {batches} {batchesWord}.",
    wouldNotes: "Notes: would send {n} {notes} in {batches} {batchesWord}.",
    waiting: "My Graph asked to slow down. Waiting {s} seconds…",
    unpaired: "My Graph doesn't know this helper any more (it was signed out or disconnected). Make a new pairing code and run with --code.",
    failed: "My Graph said: ",
    review: "What it brings waits for you to approve in My Graph (Changes).",
    scheduled: "Scheduled: it runs every {m} minutes while you're signed in to this Mac. Log: {log}",
    scheduleFda: "For the schedule, give Full Disk Access to node itself: System Settings > Privacy & Security > Full Disk Access, press +, press Cmd+Shift+G and paste:\n  {node}",
    unscheduled: "The schedule is removed.",
    forgotten: "The key and cursors are removed from this Mac. In My Graph, disconnect or sign the helper out to end it there too.",
    listHead: "Conversations this Mac can see (nothing was sent):",
    notMac: "This helper runs on a Mac (it reads Messages and Notes).",
    oldNode: "Node 18 or newer is needed (you have {v}). Get it from nodejs.org or with Homebrew: brew install node",
  },
  da: {
    intro: "My Graph til Mac",
    askCode: "Parringskode fra My Graph (fx ABCDE-FGHJK): ",
    needCode: "Denne Mac er ikke parret endnu. Lav en parringskode i My Graph (Forbindelser, My Graph til Mac) og kør:  node my-graph-mac.mjs --code ABCDE-FGHJK",
    pairing: "Parrer med My Graph…",
    paired: "Parret. Denne Mac sender til",
    http: "My Graphs adresse skal starte med https://. Stopper, så intet sendes ukrypteret.",
    fda: "Beskeder kan ikke læses: giv fuld diskadgang til det program, du kører dette fra (Terminal, iTerm eller node til planen).\n  Systemindstillinger > Anonymitet og sikkerhed > Fuld diskadgang, slå det til, luk og åbn programmet igen og kør dette igen.",
    fdaOpen: "Åbner Fuld diskadgang i Systemindstillinger…",
    notesDenied: "Noter kan ikke læses: tillad programmet, du kører dette fra, at styre Noter (Systemindstillinger > Anonymitet og sikkerhed > Automatisering), og kør dette igen.",
    catalog: "Fortalte My Graph om {chats} samtaler og {folders} mapper i Noter (kun navne).",
    nothingChosen: "Intet er valgt endnu. Vælg samtaler og/eller Noter på siden i My Graph (Forbindelser, My Graph til Mac), og kør dette igen.",
    messagesOff: "Beskeder: slået fra i My Graph.",
    notesOff: "Noter: slået fra i My Graph.",
    messagesNone: "Beskeder: slået til, men ingen samtaler er valgt endnu.",
    sentMessages: "Beskeder: sendte {n} {messagesNew} fra {chats} {conversations}.",
    sentNotes: "Noter: sendte {n} nye eller ændrede {notes}.",
    dry: "Prøvekørsel: intet blev sendt.",
    wouldMessages: "Beskeder: ville sende {n} {messages} fra {chats} {conversations} i {batches} {batchesWord}.",
    wouldNotes: "Noter: ville sende {n} {notes} i {batches} {batchesWord}.",
    waiting: "My Graph bad om at sætte farten ned. Venter {s} sekunder…",
    unpaired: "My Graph kender ikke længere denne hjælper (den blev logget ud eller afbrudt). Lav en ny parringskode og kør med --code.",
    failed: "My Graph svarede: ",
    review: "Det, den henter, venter på din godkendelse i My Graph (Ændringer).",
    scheduled: "Planlagt: den kører hvert {m}. minut, mens du er logget ind på denne Mac. Log: {log}",
    scheduleFda: "Til planen skal node selv have fuld diskadgang: Systemindstillinger > Anonymitet og sikkerhed > Fuld diskadgang, tryk +, tryk Cmd+Shift+G og indsæt:\n  {node}",
    unscheduled: "Planen er fjernet.",
    forgotten: "Nøglen og markørerne er fjernet fra denne Mac. Afbryd eller log hjælperen ud i My Graph for også at stoppe den der.",
    listHead: "Samtaler denne Mac kan se (intet blev sendt):",
    notMac: "Denne hjælper kører på en Mac (den læser Beskeder og Noter).",
    oldNode: "Node 18 eller nyere er nødvendig (du har {v}). Hent den på nodejs.org eller med Homebrew: brew install node",
  },
};
const t = T[LANG] || T.en;
const WORDS = {
  en: { messages: ["message", "messages"], messagesNew: ["new message", "new messages"], conversations: ["conversation", "conversations"], notes: ["note", "notes"], batchesWord: ["batch", "batches"] },
  da: { messages: ["besked", "beskeder"], messagesNew: ["ny besked", "nye beskeder"], conversations: ["samtale", "samtaler"], notes: ["note", "noter"], batchesWord: ["portion", "portioner"] },
};
const COUNT_OF = { messages: "n", messagesNew: "n", notes: "n", conversations: "chats", batchesWord: "batches" };
function say(key, vars) {
  const w = WORDS[LANG] || WORDS.en;
  vars = Object.assign({}, vars);
  for (const k of Object.keys(COUNT_OF)) if (vars[COUNT_OF[k]] !== undefined) vars[k] = w[k][Number(vars[COUNT_OF[k]]) === 1 ? 0 : 1];
  let s = t[key] || T.en[key] || key;
  for (const k of Object.keys(vars || {})) s = s.split("{" + k + "}").join(String(vars[k]));
  return s;
}

/* ── Pure parts (exported for the tests) ─────────────────────────────────────────────────────────────── */

/** 2001-01-01T00:00:00Z, Apple's epoch, in Unix milliseconds. */
export const APPLE_EPOCH_MS = 978307200000;

/** A chat.db date (nanoseconds since 2001 on macOS 10.13+, seconds before) as an ISO string, or null. */
export function appleToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = APPLE_EPOCH_MS + (n > 1e11 ? n / 1e6 : n * 1000);
  const d = new Date(Math.round(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An ISO date as chat.db nanoseconds (a decimal string, exact). */
export function isoToAppleNs(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return (BigInt(Math.max(0, ms - APPLE_EPOCH_MS)) * 1000000n).toString();
}

function indexOfBytes(buf, needle, from) {
  return buf.indexOf(Buffer.from(needle, "latin1"), from || 0);
}

/**
 * The text of a message whose "text" column is empty: newer macOS keeps it only in attributedBody, an NSArchiver
 * "typedstream". The string follows the NSString class name: ... "NSString" 01 94 84 01 "+" <length> <UTF-8 bytes>,
 * where the length is one byte, or 0x81 + 2 bytes / 0x82 + 4 bytes (little-endian). Best effort: null when unsure.
 */
export function textFromAttributedBody(input) {
  if (!input) return null;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "hex");
  if (!buf.length) return null;
  let at = indexOfBytes(buf, "NSString");
  if (at < 0) at = indexOfBytes(buf, "NSMutableString");
  if (at < 0) return null;
  let pos = -1;
  for (let i = at + 8; i < Math.min(buf.length, at + 24); i++) {
    if (buf[i] === 0x2b) { pos = i + 1; break; }
  }
  if (pos < 0 || pos >= buf.length) return null;
  let len, start;
  const b = buf[pos];
  if (b === 0x81) { if (pos + 3 > buf.length) return null; len = buf.readUInt16LE(pos + 1); start = pos + 3; }
  else if (b === 0x82) { if (pos + 5 > buf.length) return null; len = buf.readUInt32LE(pos + 1); start = pos + 5; }
  else if (b < 0x80) { len = b; start = pos + 1; }
  else return null;
  if (len <= 0 || start + len > buf.length) return null;
  const s = buf.subarray(start, start + len).toString("utf8");
  return s.includes("\uFFFD") && !/[\p{L}\p{N}]/u.test(s) ? null : s;
}

/** Message text as sent: no attachment placeholders, trimmed, at most 20,000 characters. */
export function cleanText(s) {
  return String(s || "").replace(/[\uFFFC\uFFFD\u0000]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, 20000);
}

/** Digits only; compare on the last 8 so +45 / 0045 / none all match (as My Graph does). */
export function normPhone(s) {
  const d = String(s || "").replace(/[^\d]/g, "");
  return d.length >= 8 ? d.slice(-8) : d;
}

const bytes = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");

/**
 * Groups messages (in ROWID order) into imessagePayload batches of at most maxBytes, each a contiguous ROWID range.
 * chatMeta(chatId) → { id, name?, participants }.
 */
export function makeMessageBatcher(opts) {
  const maxBytes = opts.maxBytes || 5000000;
  const maxMessages = opts.maxMessages || 50000;
  let cur = null;
  function fresh() { return { chats: new Map(), size: 16, count: 0, firstRowId: null, lastRowId: null }; }
  function finish(b) {
    if (!b || !b.count) return null;
    return { payload: { chats: [...b.chats.values()] }, firstRowId: b.firstRowId, lastRowId: b.lastRowId, count: b.count, chats: b.chats.size };
  }
  return {
    add(chatId, rowId, msg) {
      if (!cur) cur = fresh();
      const isNew = !cur.chats.has(chatId);
      const head = isNew ? bytes(Object.assign({}, opts.chatMeta(chatId), { messages: [] })) + 1 : 0;
      const add = bytes(msg) + 1 + head;
      let done = null;
      if (cur.count > 0 && (cur.size + add > maxBytes || cur.count >= maxMessages || (isNew && cur.chats.size >= 5000))) {
        done = finish(cur);
        cur = fresh();
        return this.add(chatId, rowId, msg) || done; // a fresh batch always takes the message
      }
      if (!cur.chats.has(chatId)) cur.chats.set(chatId, Object.assign({}, opts.chatMeta(chatId), { messages: [] }));
      cur.chats.get(chatId).messages.push(msg);
      cur.size += add;
      cur.count += 1;
      if (cur.firstRowId === null) cur.firstRowId = rowId;
      cur.lastRowId = rowId;
      return done;
    },
    flush() { const b = finish(cur); cur = null; return b; },
  };
}

/** Notes (sorted by modification) into appleNotesPayload batches of at most maxBytes. */
export function batchNotes(notes, maxBytes) {
  const max = maxBytes || 5000000;
  const out = [];
  let cur = [], size = 16;
  for (const n of notes) {
    const s = bytes(n) + 1;
    if (cur.length && (size + s > max || cur.length >= 20000)) { out.push({ notes: cur }); cur = []; size = 16; }
    cur.push(n);
    size += s;
  }
  if (cur.length) out.push({ notes: cur });
  return out;
}

/** Folders the helper never reads, in the languages Notes uses for them. */
export const DELETED_FOLDERS = ["Recently Deleted", "Senest slettet", "Nyligt raderade", "Nylig slettet", "Zuletzt gelöscht", "Récemment supprimés", "Eliminados recientemente", "Recentemente eliminati"];

/** Which notes to send: in an allowed folder, not locked, not in Recently Deleted, changed after the cursor. */
export function pickNotes(folders, allowed, cursor) {
  const allow = allowed ? new Set(allowed) : null;
  const after = cursor ? Date.parse(cursor) : 0;
  const pick = [];
  let newest = cursor || null;
  const seen = new Set();
  for (const f of folders) {
    if (DELETED_FOLDERS.includes(f.name)) continue;
    if (allow && !allow.has(f.name)) continue;
    for (const n of f.notes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (n.locked) continue;
      const u = n.updatedAt ? Date.parse(n.updatedAt) : NaN;
      if (!Number.isNaN(u) && (!newest || u > Date.parse(newest))) newest = new Date(u).toISOString();
      if (!Number.isNaN(u) && u <= after) continue;
      pick.push({ folderId: f.id, folder: f.name, id: n.id, title: n.title, createdAt: n.createdAt, updatedAt: n.updatedAt });
    }
  }
  pick.sort((a, b) => Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0));
  return { pick, newest };
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The launchd agent that runs the helper every so many minutes. */
export function launchdPlist(o) {
  const args = o.args.map((a) => "    <string>" + xmlEscape(a) + "</string>").join("\n");
  const env = Object.keys(o.env || {}).map((k) => "    <key>" + xmlEscape(k) + "</key><string>" + xmlEscape(o.env[k]) + "</string>").join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key><string>" + xmlEscape(o.label) + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>StartInterval</key><integer>" + Math.max(900, Math.round(o.everyMinutes * 60)) + "</integer>",
    "  <key>RunAtLoad</key><false/>",
    "  <key>ProcessType</key><string>Background</string>",
    "  <key>LowPriorityIO</key><true/>",
    "  <key>StandardOutPath</key><string>" + xmlEscape(o.log) + "</string>",
    "  <key>StandardErrorPath</key><string>" + xmlEscape(o.log) + "</string>",
    env ? "  <key>EnvironmentVariables</key>\n  <dict>\n" + env + "\n  </dict>" : "",
    "</dict>",
    "</plist>",
    "",
  ].filter((l) => l !== "").join("\n") + "\n";
}

/** SQL string literal. */
export function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/* ── Reading the Mac ─────────────────────────────────────────────────────────────────────────────────── */

class FdaError extends Error {}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ maxBuffer: 512 * 1024 * 1024, encoding: "utf8" }, opts || {}), (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ""); reject(err); } else resolve(String(stdout || ""));
    });
  });
}

const SQLITE = fs.existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";

/** Rows of a read-only query, with the sqlite3 tool that ships with macOS. */
export async function sqlite(db, sql) {
  let out;
  try {
    out = await run(SQLITE, ["-readonly", "-json", db, sql]);
  } catch (e) {
    const text = (e.stderr || e.message || "") + "";
    if (/authorization denied|unable to open|not authorized|operation not permitted/i.test(text)) throw new FdaError(text.trim());
    throw new Error("sqlite3: " + text.trim().slice(0, 300));
  }
  out = out.trim();
  return out ? JSON.parse(out) : [];
}

/** Names from the Contacts database, to put a name to a number (best effort; skipped with --no-contacts). */
export async function readContacts(home) {
  const base = path.join(home, "Library", "Application Support", "AddressBook");
  const files = [];
  try {
    const top = path.join(base, "AddressBook-v22.abcddb");
    if (fs.existsSync(top)) files.push(top);
    const src = path.join(base, "Sources");
    for (const d of fs.existsSync(src) ? fs.readdirSync(src) : []) {
      const f = path.join(src, d, "AddressBook-v22.abcddb");
      if (fs.existsSync(f)) files.push(f);
    }
  } catch { /* none */ }
  const phones = new Map(), emails = new Map();
  for (const f of files) {
    const nameSql = "TRIM(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) AS name, r.ZORGANIZATION AS org";
    try {
      for (const r of await sqlite(f, "SELECT " + nameSql + ", p.ZFULLNUMBER AS v FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK")) {
        const n = (r.name || r.org || "").trim();
        if (n && r.v && normPhone(r.v).length >= 8) phones.set(normPhone(r.v), n);
      }
      for (const r of await sqlite(f, "SELECT " + nameSql + ", e.ZADDRESS AS v FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK")) {
        const n = (r.name || r.org || "").trim();
        if (n && r.v) emails.set(String(r.v).trim().toLowerCase(), n);
      }
    } catch { /* that source can't be read: numbers stay numbers */ }
  }
  return (handle) => {
    const h = String(handle || "").trim();
    if (!h) return undefined;
    return h.includes("@") ? emails.get(h.toLowerCase()) : phones.get(normPhone(h));
  };
}

/** The conversations in chat.db, newest first (no messages): id, name, participants, count, last message. */
export async function readCatalog(db, nameOf, limit) {
  const chats = await sqlite(db,
    "SELECT c.ROWID AS rid, c.guid AS id, c.display_name AS name, c.chat_identifier AS ident, COUNT(m.ROWID) AS n, MAX(m.date) AS last " +
    "FROM chat c LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID LEFT JOIN message m ON m.ROWID = cmj.message_id " +
    "GROUP BY c.ROWID ORDER BY (MAX(m.date) IS NULL), MAX(m.date) DESC LIMIT " + (Number(limit) || 500));
  const parts = await sqlite(db, "SELECT chj.chat_id AS rid, h.id AS handle FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id");
  const byChat = new Map();
  for (const p of parts) {
    if (!byChat.has(p.rid)) byChat.set(p.rid, []);
    const list = byChat.get(p.rid);
    if (p.handle && !list.some((x) => x.handle === p.handle) && list.length < 30) {
      const name = nameOf ? nameOf(p.handle) : undefined;
      list.push(name ? { handle: String(p.handle).slice(0, 320), name: String(name).slice(0, 200) } : { handle: String(p.handle).slice(0, 320) });
    }
  }
  return chats.map((c) => {
    const participants = byChat.get(c.rid) || [];
    const named = (c.name && String(c.name).trim()) || (participants.length === 1 && participants[0].name) || "";
    const out = { id: String(c.id).slice(0, 300), participants, count: Number(c.n) || 0 };
    if (named) out.name = String(named).slice(0, 300);
    const last = appleToIso(c.last);
    if (last) out.lastAt = last;
    return out;
  });
}

export async function maxRowId(db) {
  const r = await sqlite(db, "SELECT MAX(ROWID) AS m FROM message");
  return Number(r[0] && r[0].m) || 0;
}

/**
 * Messages of these conversations with fromRowId < ROWID <= toRowId (and not before sinceNs), in ROWID order, a page at
 * a time. Tapbacks and group events are left out. onMessage(chatId, rowId, message).
 */
export async function readMessages(db, o, onMessage) {
  if (!o.chats.length) return 0;
  const inChats = o.chats.map(q).join(",");
  let from = Number(o.fromRowId) || 0;
  const to = Number(o.toRowId) || 0;
  const page = o.pageSize || 2000;
  let n = 0;
  while (from < to) {
    const rows = await sqlite(db,
      "SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, " +
      "CASE WHEN m.text IS NULL OR TRIM(m.text) = '' THEN hex(m.attributedBody) END AS body, " +
      "m.date AS date, m.is_from_me AS me, h.id AS handle, c.guid AS chat, m.cache_has_attachments AS att " +
      "FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id " +
      "LEFT JOIN handle h ON h.ROWID = m.handle_id " +
      "WHERE m.ROWID > " + from + " AND m.ROWID <= " + to + " AND c.guid IN (" + inChats + ") " +
      (o.sinceNs ? "AND m.date >= " + String(o.sinceNs).replace(/[^\d]/g, "") + " " : "") +
      "AND COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0 " +
      "ORDER BY m.ROWID LIMIT " + page);
    if (!rows.length) break;
    const withAtt = rows.filter((r) => Number(r.att) === 1).map((r) => Number(r.rowid));
    const atts = new Map();
    if (withAtt.length) {
      const list = await sqlite(db,
        "SELECT maj.message_id AS mid, a.transfer_name AS tn, a.filename AS fn, a.mime_type AS mime FROM message_attachment_join maj " +
        "JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id IN (" + withAtt.join(",") + ")");
      for (const a of list) {
        const name = path.basename(String(a.tn || a.fn || "attachment")).slice(0, 300);
        if (!atts.has(a.mid)) atts.set(a.mid, []);
        if (atts.get(a.mid).length < 50) atts.get(a.mid).push(a.mime ? { filename: name, mime: String(a.mime).slice(0, 100) } : { filename: name });
      }
    }
    for (const r of rows) {
      from = Math.max(from, Number(r.rowid));
      const at = appleToIso(r.date);
      if (!at) continue;
      const text = cleanText(r.text && String(r.text).trim() ? r.text : textFromAttributedBody(r.body));
      const attachments = atts.get(Number(r.rowid)) || [];
      if (!text && !attachments.length) continue;
      const fromWho = Number(r.me) === 1 ? "me" : String(r.handle || "unknown").slice(0, 320);
      await onMessage(String(r.chat), Number(r.rowid), { id: String(r.guid || r.rowid).slice(0, 300), at, from: fromWho, text, attachments });
      n++;
    }
    if (rows.length < page) break;
  }
  return n;
}

const JXA_LIST = [
  "function run(argv) {",
  "  var Notes = Application('Notes');",
  "  var out = [];",
  "  var seen = {};",
  "  function walk(f) {",
  "    var id = f.id(); if (seen[id]) return; seen[id] = true;",
  "    var ids = f.notes.id(), names = f.notes.name(), cr = f.notes.creationDate(), mo = f.notes.modificationDate(), lk = [];",
  "    try { lk = f.notes.passwordProtected(); } catch (e) { lk = []; }",
  "    var notes = [];",
  "    for (var i = 0; i < ids.length; i++) notes.push({ id: ids[i], title: names[i], createdAt: cr[i], updatedAt: mo[i], locked: !!lk[i] });",
  "    out.push({ id: id, name: f.name(), notes: notes });",
  "    var subs = f.folders(); for (var k = 0; k < subs.length; k++) walk(subs[k]);",
  "  }",
  "  var accounts = Notes.accounts();",
  "  for (var a = 0; a < accounts.length; a++) { var fs = accounts[a].folders(); for (var j = 0; j < fs.length; j++) walk(fs[j]); }",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

const JXA_BODIES = [
  "function run(argv) {",
  "  var Notes = Application('Notes');",
  "  var want = JSON.parse(argv[0]); var fid = argv[1]; var out = {}; var w = {};",
  "  for (var i = 0; i < want.length; i++) w[want[i]] = true;",
  "  try { var f = Notes.folders.byId(fid); var ids = f.notes.id(); var texts = f.notes.plaintext();",
  "    for (var j = 0; j < ids.length; j++) if (w[ids[j]]) out[ids[j]] = texts[j]; } catch (e) {}",
  "  for (var k = 0; k < want.length; k++) if (!(want[k] in out)) { try { out[want[k]] = Notes.notes.byId(want[k]).plaintext(); } catch (e) {} }",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

export const JXA = { list: JXA_LIST, bodies: JXA_BODIES };

async function jxa(script, args) {
  try {
    return JSON.parse(await run("osascript", ["-l", "JavaScript", "-e", script].concat(args || []), { timeout: 10 * 60 * 1000 }));
  } catch (e) {
    const text = (e.stderr || e.message || "") + "";
    if (/-1743|not authorized|not allowed/i.test(text)) throw Object.assign(new Error(say("notesDenied")), { notesDenied: true });
    throw new Error("Notes: " + text.trim().slice(0, 300));
  }
}

async function readNoteFolders() {
  return jxa(JXA.list);
}

async function readNoteBodies(folderId, ids) {
  return jxa(JXA.bodies, [JSON.stringify(ids), folderId]);
}

/* ── Local state: cursors here, the key in the Keychain ──────────────────────────────────────────────── */

function stateDir(opts) {
  return opts.home || process.env.MG_MAC_HOME || path.join(os.homedir(), "Library", "Application Support", "My Graph", "mac-helper");
}

function loadState(opts) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(opts), "state.json"), "utf8")); } catch { return {}; }
}

function saveState(opts, s) {
  const dir = stateDir(opts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

function useKeychain(opts) {
  return process.platform === "darwin" && !opts.noKeychain && !process.env.MG_MAC_NO_KEYCHAIN;
}

async function readToken(opts, server, s) {
  if (useKeychain(opts)) {
    try { const v = (await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", server, "-w"])).trim(); if (v) return v; } catch { /* not there */ }
  }
  return s.server === server && typeof s.token === "string" ? s.token : null;
}

async function writeToken(opts, server, token, s) {
  if (useKeychain(opts)) {
    try {
      await run("/usr/bin/security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", server, "-l", KEYCHAIN_SERVICE, "-w", token]);
      delete s.token;
      return;
    } catch { /* fall back to the 0600 file */ }
  }
  s.token = token;
}

async function dropToken(opts, server, s) {
  if (useKeychain(opts)) { try { await run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", server]); } catch { /* gone */ } }
  delete s.token;
}

/* ── Talking to My Graph ─────────────────────────────────────────────────────────────────────────────── */

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(server, p, o) {
  const opts = o || {};
  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetch(server + p, {
        method: opts.method || "GET",
        headers: Object.assign({ "user-agent": "my-graph-mac/" + HELPER_VERSION, accept: "application/json" },
          opts.token ? { authorization: "Bearer " + opts.token } : {}, opts.body !== undefined ? { "content-type": "application/json" } : {}),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      if (attempt < 4) { await sleep(2000 * attempt); continue; }
      throw new Error((e && e.message) || "network error");
    }
    const out = await res.json().catch(() => ({}));
    if (res.ok) return out;
    if (res.status === 429 && attempt < 8) {
      const s = Math.min(900, Math.max(5, Number(res.headers.get("retry-after")) || 60));
      if (!opts.quiet) console.log(say("waiting", { s }));
      await sleep(s * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 4) { await sleep(3000 * attempt); continue; }
    throw new HttpError(res.status, out.error || ("HTTP " + res.status), out.code);
  }
}

/* ── Commands ────────────────────────────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const o = { cmd: "send" };
  const rest = argv.slice();
  if (rest[0] && !rest[0].startsWith("--")) o.cmd = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    if (a === "--code") o.code = next();
    else if (a === "--my-graph") o.server = next();
    else if (a === "--chat-db") o.chatDb = next();
    else if (a === "--home") o.home = next();
    else if (a === "--every") o.every = Number(next());
    else if (a === "--dry-run") o.dry = true;
    else if (a === "--no-contacts") o.noContacts = true;
    else if (a === "--no-keychain") o.noKeychain = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--open-settings") o.openSettings = true;
  }
  return o;
}

function local(u) {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

function deviceName() {
  return (os.hostname() || "Mac").replace(/\.local$/i, "").slice(0, 80);
}

async function pair(server, code, opts, s) {
  if (!opts.quiet) console.log(say("pairing"));
  const out = await call(server, "/api/connections/mac/pair", { method: "POST", body: { pairingCode: code, device: deviceName() }, quiet: opts.quiet });
  await writeToken(opts, server, out.token, s);
  s.server = server;
  s.connectionId = out.connectionId;
  s.messages = {};
  s.notes = {};
  saveState(opts, s);
  if (!opts.quiet) console.log(say("paired") + " " + server + " (" + out.label + ").");
  return out.token;
}

async function sendMessages(ctx, settings) {
  const m = settings.messages;
  if (!m.enabled) { ctx.log(say("messagesOff")); return { n: 0 }; }
  if (!m.chats.length) { ctx.log(say("messagesNone")); return { n: 0 }; }
  const meta = new Map(ctx.catalog.map((c) => [c.id, c]));
  const chatMeta = (id) => {
    const c = meta.get(id);
    const o = { id: id, participants: c ? c.participants : [] };
    if (c && c.name) o.name = c.name;
    return o;
  };
  const snapshot = await maxRowId(ctx.db);
  const localM = ctx.state.messages || {};
  const cursor = m.cursor !== null && m.cursor !== undefined ? m.cursor
    : (localM.generation === m.generation && ctx.state.connectionId === settings.connectionId && typeof localM.rowId === "number" ? localM.rowId : null);
  const sinceNs = m.since ? isoToAppleNs(m.since) : null;
  const totals = { n: 0, chats: new Set(), batches: 0 };

  async function phase(name, chats, fromRowId, toRowId) {
    const batcher = makeMessageBatcher({ maxBytes: settings.maxBatchBytes, chatMeta });
    const post = async (b, final) => {
      totals.batches++;
      if (b) { totals.n += b.count; for (const c of b.payload.chats) totals.chats.add(c.id); }
      if (ctx.dry) return;
      const id = b ? name[0] + "-" + b.firstRowId + "-" + b.lastRowId : name[0] + "-none-" + toRowId;
      await call(ctx.server, "/api/connections/mac/import/imessage", {
        method: "POST", token: ctx.token, quiet: ctx.quiet,
        body: { runId: ctx.runId, batch: id, phase: name, lastRowId: final ? toRowId : b.lastRowId, covered: final ? chats : undefined, final: final, device: deviceName(), data: b ? b.payload : { chats: [] } },
      });
      if (name === "forward") {
        ctx.state.messages = { generation: m.generation, rowId: final ? toRowId : b.lastRowId };
        saveState(ctx.opts, ctx.state);
      }
    };
    // One batch is held back: the last one carries final (the conversations covered and where the cursor ends).
    let held = null;
    await readMessages(ctx.db, { chats, fromRowId, toRowId, sinceNs }, async (chat, rowId, msg) => {
      const done = batcher.add(chat, rowId, msg);
      if (done) { if (held) await post(held, false); held = done; }
    });
    const last = batcher.flush();
    if (last) { if (held) await post(held, false); held = last; }
    await post(held, true);
  }

  if (m.backfill.length && cursor !== null) await phase("backfill", m.backfill, 0, cursor);
  await phase("forward", m.chats, cursor || 0, Math.max(snapshot, cursor || 0));
  if (ctx.dry) ctx.log(say("wouldMessages", { n: totals.n, chats: totals.chats.size, batches: totals.batches }));
  else ctx.log(say("sentMessages", { n: totals.n, chats: totals.chats.size }));
  return { n: totals.n };
}

async function sendNotes(ctx, settings, folders) {
  const nt = settings.notes;
  if (!nt.enabled) { ctx.log(say("notesOff")); return { n: 0 }; }
  if (!folders) return { n: 0 };
  const localN = ctx.state.notes || {};
  const cursor = nt.cursor || (localN.generation === nt.generation && ctx.state.connectionId === settings.connectionId ? localN.updatedAt || null : null);
  const { pick, newest } = pickNotes(folders, nt.folders, cursor);
  const byFolder = new Map();
  for (const p of pick) { if (!byFolder.has(p.folderId)) byFolder.set(p.folderId, []); byFolder.get(p.folderId).push(p.id); }
  const bodies = {};
  if (!ctx.dry) for (const [fid, ids] of byFolder) Object.assign(bodies, await readNoteBodies(fid, ids));
  const notes = [];
  for (const p of pick) {
    const text = ctx.dry ? "" : bodies[p.id];
    if (!ctx.dry && typeof text !== "string") continue;
    const n = { id: String(p.id).slice(0, 300), title: String(p.title || "").slice(0, 500), folder: String(p.folder).slice(0, 300), text: String(text || "").replace(/\r\n?/g, "\n").slice(0, 500000) };
    if (p.createdAt) n.createdAt = new Date(p.createdAt).toISOString();
    if (p.updatedAt) n.updatedAt = new Date(p.updatedAt).toISOString();
    notes.push(n);
  }
  const batches = batchNotes(notes, settings.maxBatchBytes);
  if (ctx.dry) { ctx.log(say("wouldNotes", { n: notes.length, batches: Math.max(1, batches.length) })); return { n: notes.length }; }
  const list = batches.length ? batches : [{ notes: [] }];
  for (let i = 0; i < list.length; i++) {
    const final = i === list.length - 1;
    const b = list[i];
    const first = b.notes[0], last = b.notes[b.notes.length - 1];
    const id = b.notes.length ? "n-" + Date.parse(first.updatedAt || 0) + "-" + Date.parse(last.updatedAt || 0) + "-" + b.notes.length : "n-none";
    await call(ctx.server, "/api/connections/mac/import/apple_notes", {
      method: "POST", token: ctx.token, quiet: ctx.quiet,
      body: Object.assign({ runId: ctx.runId, batch: id, final: final, device: deviceName(), data: b }, final && newest ? { notesCursor: newest } : {}),
    });
  }
  ctx.state.notes = { generation: nt.generation, updatedAt: newest };
  saveState(ctx.opts, ctx.state);
  ctx.log(say("sentNotes", { n: notes.length }));
  return { n: notes.length };
}

async function send(opts) {
  const server = (opts.server || MY_GRAPH).replace(/\/$/, "");
  if (!server.startsWith("https://") && !local(server)) throw new Error(say("http"));
  const s = loadState(opts);
  if (s.server && s.server !== server) { s.messages = {}; s.notes = {}; s.connectionId = undefined; }
  let token = opts.code ? null : await readToken(opts, server, s);
  if (!token) {
    let code = opts.code;
    if (!code && process.stdin.isTTY && !opts.quiet) code = (await ask(say("askCode"))).trim();
    if (!code) throw new Error(say("needCode"));
    token = await pair(server, code.trim(), opts, s);
  }
  const ctx = { server, token, opts, state: s, dry: !!opts.dry, quiet: !!opts.quiet, runId: randomUUID(), db: opts.chatDb || path.join(os.homedir(), "Library", "Messages", "chat.db"), catalog: [], log: (l) => { if (!opts.quiet || /sent|sendte/i.test(l)) console.log(l); } };

  try {
    let settings = await call(server, "/api/connections/mac/settings", { token, quiet: ctx.quiet });
    // What this Mac can see, so the person can choose on the My Graph page (names only).
    const canRead = {};
    try {
      const nameOf = opts.noContacts ? null : await readContacts(os.homedir());
      ctx.catalog = await readCatalog(ctx.db, nameOf, 500);
      canRead.messages = true;
    } catch (e) {
      canRead.messages = false;
      if (e instanceof FdaError) {
        console.error(say("fda"));
        process.exitCode = 2;
        if (opts.openSettings) { console.error(say("fdaOpen")); await run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]).catch(() => {}); }
      } else console.error(e.message);
    }
    let folders = null;
    if (settings.notes.enabled) {
      try { folders = await readNoteFolders(); canRead.notes = true; } catch (e) { canRead.notes = false; console.error(e.message); }
    }
    const folderList = (folders || []).filter((f) => !DELETED_FOLDERS.includes(f.name));
    const counts = new Map();
    for (const f of folderList) counts.set(f.name, (counts.get(f.name) || 0) + f.notes.length);
    settings = await call(server, "/api/connections/mac/catalog", {
      method: "POST", token, quiet: ctx.quiet,
      body: { device: deviceName(), chats: ctx.catalog, folders: [...counts].slice(0, 200).map((x) => ({ name: x[0].slice(0, 300), count: x[1] })), canRead },
    });
    if (!opts.quiet) console.log(say("catalog", { chats: ctx.catalog.length, folders: counts.size }));
    if (!settings.messages.enabled && !settings.notes.enabled) { console.log(say("nothingChosen")); return; }
    if (canRead.messages) await sendMessages(ctx, settings);
    if (folders) await sendNotes(ctx, settings, folders);
    else if (!settings.notes.enabled) ctx.log(say("notesOff"));
    if (ctx.dry) console.log(say("dry"));
    else if (!opts.quiet) console.log(say("review"));
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      await dropToken(opts, server, s);
      saveState(opts, s);
      throw new Error(say("unpaired"));
    }
    if (e instanceof HttpError) throw new Error(say("failed") + e.message);
    throw e;
  }
}

async function list(opts) {
  const db = opts.chatDb || path.join(os.homedir(), "Library", "Messages", "chat.db");
  let chats;
  try {
    chats = await readCatalog(db, opts.noContacts ? null : await readContacts(os.homedir()), 500);
  } catch (e) {
    if (e instanceof FdaError) throw new Error(say("fda"));
    throw e;
  }
  console.log(say("listHead"));
  for (const c of chats) {
    const who = c.participants.map((p) => p.name ? p.name + " (" + p.handle + ")" : p.handle).join(", ");
    console.log("  " + (c.name || who || c.id) + "  ·  " + c.count + "  ·  " + (c.lastAt ? c.lastAt.slice(0, 10) : "-"));
  }
}

function agentPaths(opts) {
  const home = os.homedir();
  return {
    plist: path.join(home, "Library", "LaunchAgents", AGENT_LABEL + ".plist"),
    script: path.join(stateDir(opts), "my-graph-mac.mjs"),
    log: path.join(home, "Library", "Logs", "My Graph", "mac-helper.log"),
  };
}

async function schedule(opts) {
  const p = agentPaths(opts);
  const every = Math.min(24 * 60, Math.max(15, Number(opts.every) || 60));
  fs.mkdirSync(path.dirname(p.script), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.copyFileSync(fileURLToPath(import.meta.url), p.script);
  const args = [process.execPath, p.script, "send", "--quiet"];
  if (opts.server) args.push("--my-graph", opts.server);
  if (opts.chatDb) args.push("--chat-db", opts.chatDb);
  if (opts.noContacts) args.push("--no-contacts");
  const env = opts.home ? { MG_MAC_HOME: opts.home } : {};
  fs.writeFileSync(p.plist, launchdPlist({ label: AGENT_LABEL, args, everyMinutes: every, log: p.log, env }));
  const uid = String(process.getuid ? process.getuid() : "");
  await run("launchctl", ["bootout", "gui/" + uid, p.plist]).catch(() => {});
  await run("launchctl", ["bootstrap", "gui/" + uid, p.plist]);
  console.log(say("scheduled", { m: every, log: p.log }));
  console.log(say("scheduleFda", { node: process.execPath }));
}

async function unschedule(opts) {
  const p = agentPaths(opts);
  const uid = String(process.getuid ? process.getuid() : "");
  await run("launchctl", ["bootout", "gui/" + uid, p.plist]).catch(() => {});
  try { fs.unlinkSync(p.plist); } catch { /* not there */ }
  console.log(say("unscheduled"));
}

async function forget(opts) {
  const server = (opts.server || MY_GRAPH).replace(/\/$/, "");
  const s = loadState(opts);
  await dropToken(opts, s.server || server, s);
  try { fs.rmSync(path.join(stateDir(opts), "state.json")); } catch { /* not there */ }
  console.log(say("forgotten"));
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error(say("oldNode", { v: process.versions.node }));
  if (process.platform !== "darwin" && !opts.chatDb) throw new Error(say("notMac"));
  if (!opts.quiet && opts.cmd === "send") console.log(say("intro") + "\n");
  if (opts.cmd === "send" || opts.cmd === "pair") return send(opts);
  if (opts.cmd === "list") return list(opts);
  if (opts.cmd === "schedule") return schedule(opts);
  if (opts.cmd === "unschedule") return unschedule(opts);
  if (opts.cmd === "forget") return forget(opts);
  console.log("node my-graph-mac.mjs [send|list|schedule|unschedule|forget] [--code CODE] [--dry-run] [--every MINUTES] [--no-contacts]");
}

const self = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return ""; } })();
const invoked = (() => { try { return process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : ""; } catch { return ""; } })();
if (self && self === invoked) {
  main(process.argv.slice(2)).then(() => process.exit(process.exitCode || 0), (e) => {
    console.error("\n" + (e && e.message ? e.message : e) + "\n");
    process.exit(1);
  });
}
`;

/** The helper with My Graph's address and the person's language filled in. */
export function helperSource(myGraphUrl: string, lang: "en" | "da"): string {
  const safeUrl = myGraphUrl.replace(/["\\\n\r]/g, "");
  return SOURCE.replace("__MY_GRAPH_URL__", safeUrl).replace("__LANG__", lang);
}
