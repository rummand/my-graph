import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connectorKey, decryptSecrets, encryptSecrets, redact } from "./crypto";
import { classify, CursorExpired, httpError } from "./errors";
import { clampEvery, defineManifest, validateManifest, type Manifest } from "./manifest";
import { CONNECTORS, connectorById, connectorInfo, offeredIn } from "./registry";
import { afterRun, backoffMinutes, cursorOf, isResetSignal, readState, resetStream, withCursor } from "./state";
import { assertPublicHost, checkUrl, isPrivateAddress } from "./ssrf";
import { diffEvents, parseIcs, zonedToUtc } from "./ics/parse";
import { eventOps, proposalTitle } from "./ics/ops";
import { advance, batches, imapExternalId, newUids, planFolder, rangeFrom, sinceDate } from "./imap/cursor";

const prod = { NODE_ENV: "production" } as Record<string, string | undefined>;

describe("manifests", () => {
  it("every registered connector has a valid manifest", () => {
    for (const c of CONNECTORS) expect(validateManifest(c.manifest), c.manifest.id).toEqual({ ok: true });
    expect(new Set(CONNECTORS.map((c) => c.manifest.id)).size).toBe(CONNECTORS.length);
  });

  it("refuses broken manifests with plain problems", () => {
    const bad = {
      id: "Bad Id", version: "x", status: "official", icon: "mail", auth: { type: "app_password" },
      config: z.object({ host: z.string() }), secrets: z.object({}),
      fields: [{ key: "nope", kind: "text" }],
      streams: [{ name: "a", key: "id", cursor: "c", resetOn: [] }, { name: "a", key: "id", cursor: "c", resetOn: [] }],
      schedule: { everyMinutes: 5 }, rateLimit: { perMinute: 1, backoff: "exponential" }, maps: { b: "event" },
    } as unknown as Manifest;
    const r = validateManifest(bad);
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.problems.join("\n");
    expect(text).toMatch(/^id:/m);
    expect(text).toMatch(/schedule\.everyMinutes/);
    expect(text).toMatch(/"a" appears twice/);
    expect(text).toMatch(/stream "a" isn't mapped/);
    expect(text).toMatch(/"b" is not a stream/);
    expect(text).toMatch(/"nope" is not in the config schema/);
    expect(() => defineManifest(bad)).toThrow(/invalid/);
  });

  it("never schedules under 15 minutes", () => {
    const m = connectorById("aula_calendar")!.manifest;
    expect(clampEvery(1, m)).toBe(15);
    expect(clampEvery(undefined, m)).toBe(15);
    expect(clampEvery(60, m)).toBe(60);
  });

  it("offers Aula only in a family graph, as unofficial, and plugins only to the platform admin", () => {
    const ids = (kind: string, admin = false) => offeredIn(kind, admin).map((c) => c.manifest.id);
    for (const kind of ["family", "personal", "work", "shared"]) {
      expect(ids(kind)).not.toContain("plugin");
      expect(ids(kind, true)).toContain("plugin");
      expect(ids(kind)).toEqual(expect.arrayContaining(["record", "imap", "ics", "mcp", "gmail", "microsoft", "dropbox"]));
    }
    expect(ids("family")).toEqual(expect.arrayContaining(["aula_calendar", "aula"]));
    for (const kind of ["personal", "work", "shared", "practice"]) expect(ids(kind)).not.toContain("aula");
    // Every connector in a graph kind's list is offered there by its own manifest.
    for (const c of offeredIn("work")) expect(!c.manifest.graphKinds?.length || c.manifest.graphKinds.includes("work")).toBe(true);
    const aula = connectorInfo(connectorById("aula")!);
    expect(aula.status).toBe("unofficial");
    expect(aula.authType).toBe("mitid_session");
    expect(aula.region).toBe("dk");
    expect(typeof connectorById("aula")!.sync).toBe("function");
  });

  it("keeps Danish-only connectors in the Denmark group, and only them", () => {
    for (const c of offeredIn("family", true)) {
      if (c.manifest.region === "dk") expect(["aula", "aula_calendar", "holdsport", "minuddannelse", "digital_post", "sundhed"]).toContain(c.manifest.id);
    }
  });

  it("validates config and secrets with the manifest's schemas", () => {
    const imap = connectorById("imap")!.manifest;
    expect(imap.config.safeParse({ host: "imap.example.com", user: "a@b.dk" }).success).toBe(true);
    expect(imap.config.safeParse({ host: "", user: "a@b.dk" }).success).toBe(false);
    const parsed = imap.config.parse({ host: "imap.example.com", user: "a@b.dk" }) as { port: number; folders: string[] };
    expect(parsed.port).toBe(993);
    expect(parsed.folders).toEqual(["INBOX"]);
    const aula = connectorById("aula_calendar")!.manifest;
    expect(aula.secrets.safeParse({}).success).toBe(false);
    expect(aula.secrets.safeParse({ weekUrl: "https://www.aula.dk/calendar/abc123" }).success).toBe(true);
  });
});

describe("secrets", () => {
  const key = connectorKey({ CONNECTOR_KEY: "a".repeat(64) });
  it("round-trips with AES-256-GCM and a fresh IV each time", () => {
    const s = { password: "app-pass wørd", url: "https://x.dk/cal?token=42" };
    const a = encryptSecrets(s, "conn-1", key);
    const b = encryptSecrets(s, "conn-1", key);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("app-pass");
    expect(decryptSecrets(a, "conn-1", key)).toEqual(s);
    expect(decryptSecrets(null, "conn-1", key)).toEqual({});
  });
  it("refuses another connection's ciphertext, a wrong key and tampering", () => {
    const a = encryptSecrets({ password: "x" }, "conn-1", key);
    expect(() => decryptSecrets(a, "conn-2", key)).toThrow();
    expect(() => decryptSecrets(a, "conn-1", connectorKey({ CONNECTOR_KEY: "b".repeat(64) }))).toThrow();
    const raw = Buffer.from(a.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecrets(`v1:${raw.toString("base64")}`, "conn-1", key)).toThrow();
  });
  it("derives the key from SESSION_SECRET when CONNECTOR_KEY is missing, and needs one in production", () => {
    const k1 = connectorKey({ SESSION_SECRET: "s3cret" });
    expect(k1.length).toBe(32);
    expect(k1.equals(connectorKey({ SESSION_SECRET: "s3cret" }))).toBe(true);
    expect(k1.equals(connectorKey({ SESSION_SECRET: "other" }))).toBe(false);
    expect(connectorKey({ CONNECTOR_KEY: "a passphrase" }).length).toBe(32);
    expect(() => connectorKey({ NODE_ENV: "production" })).toThrow(/CONNECTOR_KEY/);
  });
  it("redacts secret values (and secret URL paths) from messages", () => {
    const s = { url: "https://www.aula.dk/cal/feed/abcdef123456?t=zzzzzzzzzz", password: "hunter22" };
    expect(redact("GET https://www.aula.dk/cal/feed/abcdef123456?t=zzzzzzzzzz failed", s)).toBe("GET … failed");
    expect(redact("path /cal/feed/abcdef123456 gone; pw hunter22", s)).toBe("path /… gone; pw …");
  });
});

describe("state, cursors and back-off", () => {
  it("moves one stream's cursor and resets through one path", () => {
    let s = readState({});
    s = withCursor(s, "week", { etag: "a" });
    s = withCursor(s, "year", { etag: "b" });
    expect(cursorOf(s, "week")).toEqual({ etag: "a" });
    s = resetStream(s, "week");
    expect(cursorOf(s, "week")).toBeUndefined();
    expect(cursorOf(s, "year")).toEqual({ etag: "b" });
    expect(s.streams!.week.resets).toBe(1);
    expect(resetStream(s, "week").streams!.week.resets).toBe(2);
    expect(readState("junk")).toEqual({});
  });
  it("recognises reset signals from the manifest", () => {
    expect(isResetSignal([410, "uidvalidity"], 410)).toBe(true);
    expect(isResetSignal([410, "uidvalidity"], "UIDVALIDITY")).toBe(true);
    expect(isResetSignal([410], 404)).toBe(false);
    expect(new CursorExpired("mail", "uidvalidity").stream).toBe("mail");
  });
  it("backs off exponentially, capped, never under 15 minutes", () => {
    expect(backoffMinutes(15, 0)).toBe(15);
    expect(backoffMinutes(15, 1)).toBe(30);
    expect(backoffMinutes(15, 2)).toBe(60);
    expect(backoffMinutes(60, 1)).toBe(60);
    expect(backoffMinutes(15, 30)).toBe(720);
    expect(backoffMinutes(5, 0)).toBe(15);
  });
  it("needs-you stops the schedule; will-retry counts failures; ok clears them", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    expect(afterRun({ now, everyMinutes: 15, failures: 3, outcome: "ok" })).toEqual({ status: "ok", nextRunAt: new Date("2026-11-04T10:15:00Z"), failures: 0 });
    expect(afterRun({ now, everyMinutes: 15, failures: 0, outcome: "needs_you" })).toMatchObject({ status: "needs_you", nextRunAt: null });
    const r = afterRun({ now, everyMinutes: 15, failures: 1, outcome: "retry" });
    expect(r).toEqual({ status: "error", nextRunAt: new Date("2026-11-04T11:00:00Z"), failures: 2 });
  });
  it("sorts errors into needs-you and will-retry", () => {
    expect(httpError(401).kind).toBe("needs_you");
    expect(httpError(404).kind).toBe("needs_you");
    expect(httpError(503).kind).toBe("retry");
    expect(httpError(429).kind).toBe("retry");
    expect(classify({ authenticationFailed: true }).kind).toBe("needs_you");
    expect(classify(Object.assign(new Error("x"), { code: "ECONNRESET" })).kind).toBe("retry");
    expect(classify(new Error("boom")).kind).toBe("retry");
  });
});

describe("SSRF guard", () => {
  it("refuses private, loopback, link-local and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "not-an-ip"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("checks pasted links and host names (localhost only in development)", () => {
    expect(checkUrl("webcal://www.aula.dk/cal.ics", prod).protocol).toBe("https:");
    expect(() => checkUrl("http://example.com/x.ics", prod)).toThrow(/https/);
    expect(() => checkUrl("https://localhost/x.ics", prod)).toThrow(/internet/);
    expect(() => checkUrl("https://192.168.0.10/x.ics", prod)).toThrow(/internet/);
    expect(() => checkUrl("https://[::1]/x.ics", prod)).toThrow(/internet/);
    expect(() => checkUrl("https://a:b@example.com/x", prod)).toThrow(/user name/);
    expect(() => checkUrl("ftp://example.com/x", prod)).toThrow();
    expect(() => checkUrl("https://example.com:22/x", prod)).toThrow(/port/);
    expect(() => assertPublicHost("printer.local", prod)).toThrow();
    expect(() => assertPublicHost("imap.gmail.com", prod)).not.toThrow();
    expect(() => assertPublicHost("localhost", { NODE_ENV: "development" })).not.toThrow();
    expect(checkUrl("http://localhost:3999/x.ics", { NODE_ENV: "development" }).port).toBe("3999");
    // Development opens this computer only: never link-local (cloud metadata) or the home network.
    const dev = { NODE_ENV: "development" };
    expect(checkUrl("http://127.0.0.1:39417/x.ics", dev).hostname).toBe("127.0.0.1");
    expect(() => checkUrl("http://169.254.169.254/latest/meta-data/", dev)).toThrow(/internet/);
    expect(() => checkUrl("http://[::ffff:169.254.169.254]/", dev)).toThrow(/internet/);
    expect(() => checkUrl("http://10.0.0.1/x.ics", dev)).toThrow(/internet/);
    expect(() => checkUrl("http://metadata.google.internal/", dev)).toThrow(/internet/);
  });
});

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Aula//DA
X-WR-CALNAME:Emmas kalender
X-WR-TIMEZONE:Europe/Copenhagen
BEGIN:VEVENT
UID:trip-1@aula
DTSTAMP:20261101T120000Z
DTSTART;TZID=Europe/Copenhagen:20261126T083000
DTEND;TZID=Europe/Copenhagen:20261126T140000
SUMMARY:Tur i Zoo
LOCATION:Københavns Zoo
DESCRIPTION:Husk madpakke og\\, regntøj.
END:VEVENT
BEGIN:VEVENT
UID:closed-1@aula
DTSTART;VALUE=DATE:20261223
DTEND;VALUE=DATE:20261224
SUMMARY:Lukkedag
END:VEVENT
BEGIN:VEVENT
UID:swim@aula
DTSTART:20261102T130000Z
DTEND:20261102T140000Z
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Svømning
END:VEVENT
BEGIN:VEVENT
UID:swim@aula
RECURRENCE-ID:20261109T130000Z
DTSTART:20261109T150000Z
DTEND:20261109T160000Z
SUMMARY:Svømning (flyttet)
END:VEVENT
BEGIN:VEVENT
UID:cancel-1@aula
DTSTART:20261201T100000Z
SUMMARY:Forældremøde
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:old@aula
DTSTART:20200101T100000Z
SUMMARY:Long ago
END:VEVENT
BEGIN:VEVENT
DTSTART:20261201T100000Z
SUMMARY:No uid
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, "\r\n");

describe("ICS", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  it("parses zones, all-day dates, repeats with exceptions and cancellations", () => {
    const cal = parseIcs(ICS, { now });
    expect(cal.name).toBe("Emmas kalender");
    const byKey = Object.fromEntries(cal.events.map((e) => [e.key, e]));
    const trip = byKey["trip-1@aula"];
    expect(trip.start.toISOString()).toBe("2026-11-26T07:30:00.000Z"); // CET = UTC+1
    expect(trip.end!.toISOString()).toBe("2026-11-26T13:00:00.000Z");
    expect(trip.description).toBe("Husk madpakke og, regntøj.");
    expect(trip.location).toBe("Københavns Zoo");
    const closed = byKey["closed-1@aula"];
    expect(closed.allDay).toBe(true);
    expect(closed.date).toBe("2026-12-23");
    const swims = cal.events.filter((e) => e.uid === "swim@aula");
    expect(swims.map((e) => e.start.toISOString())).toEqual(["2026-11-02T13:00:00.000Z", "2026-11-09T15:00:00.000Z", "2026-11-16T13:00:00.000Z"]);
    expect(swims[1].summary).toBe("Svømning (flyttet)");
    expect(new Set(swims.map((e) => e.key)).size).toBe(3);
    expect(byKey["cancel-1@aula"].status).toBe("cancelled");
    expect(byKey["old@aula"]).toBeUndefined(); // outside the window
    expect(cal.skipped).toBe(1); // no UID
  });
  it("handles summer time and refuses things that aren't calendars", () => {
    expect(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, "Europe/Copenhagen").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(() => parseIcs("<html>Sign in</html>")).toThrow(/calendar/);
  });
  it("dedupes by UID: unchanged, changed, new and cancelled", () => {
    const first = parseIcs(ICS, { now });
    const known = new Map(first.events.map((e) => [e.key, { fingerprint: e.fingerprint, cancelled: e.status === "cancelled" }]));
    expect(diffEvents(first.events, known).every((v) => v.action === "unchanged")).toBe(true);
    const changed = parseIcs(ICS.replace("Tur i Zoo", "Tur i Zoo (ny tid)").replace("UID:cancel-1@aula\r\nDTSTART:20261201T100000Z\r\nSUMMARY:Forældremøde\r\nSTATUS:CANCELLED", "UID:cancel-1@aula\r\nDTSTART:20261201T100000Z\r\nSUMMARY:Forældremøde"), { now });
    const known2 = new Map(first.events.map((e) => [e.key, { fingerprint: e.fingerprint, cancelled: false }]));
    known2.delete("closed-1@aula");
    const v = Object.fromEntries(diffEvents(changed.events, known2).map((x) => [x.key, x.action]));
    expect(v["trip-1@aula"]).toBe("update");
    expect(v["closed-1@aula"]).toBe("add");
    expect(v["cancel-1@aula"]).toBe("update");
    const v3 = Object.fromEntries(diffEvents(first.events, known2).map((x) => [x.key, x.action]));
    expect(v3["cancel-1@aula"]).toBe("cancel");
  });
  it("proposes events with receipts, reusing the node id on change", () => {
    const cal = parseIcs(ICS, { now });
    const trip = cal.events.find((e) => e.uid === "trip-1@aula")!;
    const base = { event: trip, sourceId: "s1", nodeId: "n1", visibility: "parents" as const, calendarName: "Emmas kalender", connectionLabel: "Aula calendar" };
    const add = eventOps({ ...base, action: "add", nodeExists: false, personNodeId: "p1" });
    expect(add.map((o) => o.op)).toEqual(["addNode", "addEdge"]);
    expect(add[0]).toMatchObject({ op: "addNode", nodeId: "n1", type: "event", label: "Tur i Zoo", startAt: "2026-11-26T07:30:00.000Z", visibility: "parents", receipt: { sourceId: "s1" } });
    expect(add[1]).toMatchObject({ op: "addEdge", fromId: "n1", toId: "p1", relation: "involves" });
    expect(eventOps({ ...base, action: "update", nodeExists: true }).map((o) => o.op)).toEqual(["updateNode"]);
    expect(eventOps({ ...base, action: "update", nodeExists: false })[0]).toMatchObject({ op: "addNode", nodeId: "n1" });
    expect(eventOps({ ...base, action: "cancel", nodeExists: true })[0]).toMatchObject({ op: "retireNode", nodeId: "n1" });
    expect(eventOps({ ...base, action: "cancel", nodeExists: false })).toEqual([]);
    // The same event already came in from another parent's calendar: only the edge.
    expect(eventOps({ ...base, action: "add", nodeExists: true, personNodeId: "p2" }).map((o) => o.op)).toEqual(["addEdge"]);
    expect(proposalTitle({ add: 3, update: 1, cancel: 0 }, "Aula calendar")).toBe("3 new dates, 1 change from Aula calendar");
  });
});

describe("IMAP cursor maths", () => {
  it("plans first look, incremental, nothing new and reset", () => {
    expect(planFolder(undefined, { uidValidity: 7n })).toEqual({ mode: "initial", uidValidity: "7", reason: "new" });
    expect(planFolder({ uidValidity: "7", lastUid: 41 }, { uidValidity: 7n, uidNext: 50 })).toEqual({ mode: "incremental", uidValidity: "7", fromUid: 42 });
    expect(planFolder({ uidValidity: "7", lastUid: 41 }, { uidValidity: 7, uidNext: 42 })).toEqual({ mode: "nothing", uidValidity: "7" });
    expect(planFolder({ uidValidity: "7", lastUid: 41 }, { uidValidity: 8, uidNext: 3 })).toEqual({ mode: "reset", uidValidity: "8", reason: "uidvalidity" });
    expect(rangeFrom(42)).toBe("42:*");
  });
  it("drops the newest message that n:* always returns, dedupes, sorts and caps", () => {
    expect(newUids([41], 41, 10)).toEqual({ take: [], more: false });
    expect(newUids([45, 42, 43, 43, 41], 41, 2)).toEqual({ take: [42, 43], more: true });
  });
  it("advances only forward and starts over on a new UIDVALIDITY", () => {
    expect(advance({ uidValidity: "7", lastUid: 41 }, "7", [42, 44, 43])).toEqual({ uidValidity: "7", lastUid: 44 });
    expect(advance({ uidValidity: "7", lastUid: 41 }, "7", [])).toEqual({ uidValidity: "7", lastUid: 41 });
    expect(advance({ uidValidity: "7", lastUid: 41 }, "8", [3])).toEqual({ uidValidity: "8", lastUid: 3 });
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("reads since a date and names messages without a Message-ID", () => {
    expect(sinceDate("2026-09-01", new Date()).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(sinceDate(undefined, new Date("2026-11-04T00:00:00Z")).toISOString()).toBe("2026-08-06T00:00:00.000Z");
    expect(imapExternalId(undefined, "INBOX", "7", 3)).toBe("imap:INBOX:7:3");
    expect(imapExternalId("a@b", "INBOX", "7", 3)).toBe("a@b");
  });
});
