import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedTransport } from "@/lib/mcp-client/transport";
import { AulaApi, AulaError, cookiesFrom, READ_METHODS } from "./client";
import { aulaBases, authorizeUrl } from "./constants";
import { afterThread, aulaTs, calendarWindows, finishThreads, newMessages, planThreads, scanPage, threadChanged, type ThreadsCursor } from "./cursor";
import {
  accountFrom, albumSource, eventOf, eventOps, matchPerson, messageOf, messageSource, peopleOps, presenceSource, scopeIds, SENSITIVE_TITLE,
  sensitiveSource, threadOf, type AulaMessage, type AulaThread, type KnownNode,
} from "./mapping";
import { readCalendar, readGallery, readPosts, readPresence, readThreads } from "./read";
import { mintTokens, startMockAula } from "./testing/mock-aula";
import { needsRefresh, parseTokenResponse, refreshTokens, tokensFrom } from "./tokens";

const DEV = { NODE_ENV: "development" } as Record<string, string | undefined>;
const transport = guardedTransport(DEV);
let mock: Awaited<ReturnType<typeof startMockAula>>;

beforeAll(async () => { mock = await startMockAula(); });
afterAll(async () => { await mock.close(); });

function apiWith(token: string, version = 24, onVersionChanged?: (a: number, b: number) => void) {
  return new AulaApi({ transport, apiBase: mock.url, accessToken: () => token, version, onVersionChanged });
}

const thread = (id: string, at: string | null, extra: Partial<AulaThread> = {}): AulaThread => ({
  id, subject: `T${id}`, sensitive: false, latestAt: at ? new Date(at) : null, latestMessageId: null, creator: null, recipients: [], children: [], institution: null, ...extra,
});
const msg = (id: string, at: string): AulaMessage => ({ id, at: new Date(at), sender: null, text: "x", attachments: [], kind: "message" });

describe("Aula API version probing", () => {
  it("walks past retired versions (410) to the live one and says so", async () => {
    const { access_token } = mintTokens(mock.state);
    const changes: [number, number][] = [];
    const api = apiWith(access_token, 24, (a, b) => changes.push([a, b]));
    await api.profilesByLogin();
    expect(api.apiVersion).toBe(26);
    expect(changes).toEqual([[24, 26]]);
    expect(api.calls.filter((c) => c.startsWith("probe:"))).toEqual(["probe:v24", "probe:v25", "probe:v26"]);
  });

  it("re-probes once when Aula retires the version mid-run, then repeats the request", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = apiWith(access_token, 26);
    await api.threadsPage(0);
    mock.state.version = 27;
    try {
      const page = await api.threadsPage(0);
      expect(api.apiVersion).toBe(27);
      expect(page?.threads?.length).toBeGreaterThan(0);
    } finally {
      mock.state.version = 26;
    }
  });

  it("stops at a version that isn't there instead of walking forever", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = new AulaApi({ transport, apiBase: mock.url, accessToken: () => access_token, version: 20, maxVersion: 23 });
    await expect(api.profilesByLogin()).rejects.toMatchObject({ kind: "version" });
  });

  it("says the sign-in ended on an invalid token", async () => {
    const api = apiWith("at_not_a_real_token", 26);
    await expect(api.profilesByLogin()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("read only", () => {
  it("refuses every method that isn't a read, before sending anything", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = apiWith(access_token, 26);
    const before = mock.state.calls.length;
    for (const m of ["messaging.setLastReadMessage", "presence.updateStatusByInstitutionProfileIds", "messaging.reply", "presence.updatePresenceTemplate"]) {
      await expect(api.call(m)).rejects.toMatchObject({ kind: "refused" });
    }
    expect(mock.state.calls.length).toBe(before);
    expect(READ_METHODS.has("messaging.setLastReadMessage")).toBe(false);
  });

  it("reading every thread never calls setLastReadMessage and never moves a read marker", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = apiWith(access_token, 26);
    await readThreads(api, {}, { since: new Date("2026-09-01T00:00:00Z"), now: new Date("2026-11-04T12:00:00Z") });
    expect(mock.state.calls.some((c) => c.method === "messaging.setLastReadMessage")).toBe(false);
    expect(mock.state.threads[0].lastReadMessageId).toBeNull();
    expect(new Set(api.calls.filter((c) => !c.startsWith("probe:")))).toEqual(new Set(["messaging.getThreads", "messaging.getMessagesForThread"]));
  });
});

describe("tokens", () => {
  it("refreshes with the refresh token, which rotates (a spent one is refused)", async () => {
    const t = mintTokens(mock.state);
    const next = await refreshTokens(transport, mock.url, t.refresh_token, { now: () => 1_000 });
    expect(next.accessToken).not.toBe(t.access_token);
    expect(next.refreshToken).not.toBe(t.refresh_token);
    expect(next.expiresAt).toBe(1_000 + 3600 * 1000);
    await expect(refreshTokens(transport, mock.url, t.refresh_token)).rejects.toMatchObject({ kind: "auth" });
  });

  it("an expired access token is refreshed and works again", async () => {
    const t = mintTokens(mock.state);
    let token = t.access_token;
    mock.expireAll();
    const api = new AulaApi({ transport, apiBase: mock.url, accessToken: () => token, version: 26 });
    await expect(api.profilesByLogin()).rejects.toMatchObject({ kind: "auth" });
    token = (await refreshTokens(transport, mock.url, t.refresh_token)).accessToken;
    const api2 = new AulaApi({ transport, apiBase: mock.url, accessToken: () => token, version: 26 });
    expect(accountFrom(await api2.profilesByLogin()).name).toBe("Anna Hansen");
  });

  it("parses token answers and knows when to refresh", () => {
    expect(() => parseTokenResponse("{}")).toThrow(AulaError);
    const t = parseTokenResponse(JSON.stringify({ access_token: "aaaaaaaa", expires_in: 60 }), 0, "rrrrrrrr");
    expect(t).toEqual({ accessToken: "aaaaaaaa", refreshToken: "rrrrrrrr", expiresAt: 60_000 });
    expect(needsRefresh({ expiresAt: 600_000 }, 0)).toBe(false);
    expect(needsRefresh({ expiresAt: 600_000 }, 480_001)).toBe(true);
    expect(tokensFrom({ accessToken: "a" })).toBeNull();
  });

  it("builds the authorize address the helper opens (PKCE S256, Aula's app client)", () => {
    const u = new URL(authorizeUrl("https://login.aula.dk", { state: "s1", codeChallenge: "c1" }));
    expect(u.pathname).toBe("/simplesaml/module.php/oidc/authorize.php");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app-private.aula.dk");
  });

  it("only uses a mock address where connectors may reach this computer", () => {
    expect(aulaBases("http://127.0.0.1:7311", { NODE_ENV: "production" }).api).toBe("https://www.aula.dk");
    expect(aulaBases("http://127.0.0.1:7311", DEV).api).toBe("http://127.0.0.1:7311");
  });
});

describe("thread cursor (latest message time)", () => {
  const cur: ThreadsCursor = { latestMessageAt: "2026-10-21T00:00:00.000Z", threads: { a: "2026-10-20T10:00:00.000Z" } };

  it("knows which threads changed", () => {
    expect(threadChanged(thread("a", "2026-10-20T10:00:00Z"), cur)).toBe(false);
    expect(threadChanged(thread("a", "2026-10-22T10:00:00Z"), cur)).toBe(true);
    expect(threadChanged(thread("b", "2026-10-22T10:00:00Z"), cur)).toBe(true);
    expect(threadChanged(thread("c", "2026-10-01T10:00:00Z"), cur)).toBe(false);
  });

  it("stops paging at the first unchanged thread older than the cursor, or older than the start date", () => {
    const page = [thread("x", "2026-10-25T00:00:00Z"), thread("a", "2026-10-20T10:00:00Z"), thread("y", "2026-10-26T00:00:00Z")];
    expect(scanPage(page, cur, new Date("2026-01-01")).changed.map((t) => t.id)).toEqual(["x"]);
    expect(scanPage(page, cur, new Date("2026-01-01")).stop).toBe(true);
    expect(scanPage([thread("z", "2025-01-01T00:00:00Z")], {}, new Date("2026-01-01"))).toEqual({ changed: [], stop: true });
  });

  it("reads oldest first, capped, and only moves the cursor when the whole range was read", () => {
    const changed = [thread("3", "2026-10-30T00:00:00Z"), thread("1", "2026-10-10T00:00:00Z"), thread("2", "2026-10-20T00:00:00Z")];
    const plan = planThreads(changed, 2);
    expect(plan.take.map((t) => t.id)).toEqual(["1", "2"]);
    expect(plan.more).toBe(true);
    const after = afterThread({}, plan.take[0], [msg("m", "2026-10-10T00:00:00Z")]);
    expect(after.threads?.["1"]).toBe("2026-10-10T00:00:00.000Z");
    const now = new Date("2026-11-01T00:00:00Z");
    expect(finishThreads(after, changed, false, now).latestMessageAt ?? null).toBeNull();
    expect(finishThreads(after, changed, true, now).latestMessageAt).toBe("2026-10-30T00:00:00.000Z");
  });

  it("keeps only messages newer than what is stored for the thread", () => {
    const r = newMessages([msg("3", "2026-10-22T00:00:00Z"), msg("2", "2026-10-20T10:00:00Z"), msg("1", "2026-10-19T00:00:00Z")], "2026-10-20T10:00:00.000Z");
    expect(r.fresh.map((m) => m.id)).toEqual(["3"]);
    expect(r.reachedKnown).toBe(true);
  });

  it("a second run against Aula brings nothing new; a new message brings exactly one", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = apiWith(access_token, 26);
    const opts = { since: new Date("2026-09-01T00:00:00Z"), now: new Date("2026-11-04T12:00:00Z") };
    const first = await readThreads(api, {}, opts);
    expect(first.items.map((i) => i.read.thread.id)).toEqual(["9001", "9002"]);
    expect(first.final.latestMessageAt).toBe("2026-10-25T08:00:00.000Z");
    const second = await readThreads(api, first.final, opts);
    expect(second.items).toEqual([]);
    mock.state.threads[0].messages.push({ id: "m1.3", at: "2026-11-02T09:00:00+01:00", sender: { fullName: "Mette Jensen", role: "employee" }, html: "Husk kaffe." });
    try {
      const third = await readThreads(api, second.final, opts);
      expect(third.items).toHaveLength(1);
      expect(third.items[0].read.messages.map((m) => m.id)).toEqual(["m1.3"]);
      expect(third.final.latestMessageAt).toBe("2026-11-02T08:00:00.000Z");
    } finally {
      mock.state.threads[0].messages.pop();
    }
  });
});

describe("sensitive threads", () => {
  it("are never opened: they come back as a placeholder with no text", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = apiWith(access_token, 26);
    const r = await readThreads(api, {}, { since: new Date("2026-09-01T00:00:00Z"), now: new Date("2026-11-04T12:00:00Z") });
    const s = r.items.find((i) => i.read.thread.id === "9002")!;
    expect(s.read.sensitive).toBe(true);
    expect(s.read.messages).toEqual([]);
    expect(mock.state.calls.some((c) => c.method === "messaging.getMessagesForThread" && c.threadId === "9002")).toBe(false);
    const src = sensitiveSource(s.read.thread, "https://www.aula.dk/portal/");
    expect(src.title).toBe(SENSITIVE_TITLE);
    expect(src.text).toBeNull();
    expect(src.sensitive).toBe(true);
    expect(src.url).toBe("https://www.aula.dk/portal/#/beskeder/9002");
    expect(JSON.stringify(src)).not.toContain("trivsel");
  });

  it("a thread Aula only reveals as sensitive when opened (step-up) becomes a placeholder too", async () => {
    const { access_token } = mintTokens(mock.state);
    mock.state.threads.push({ id: 9003, subject: "Samtale", stepUpOnOpen: true, messages: [{ id: "m3.1", at: "2026-10-26T10:00:00+01:00", sender: { fullName: "Mette Jensen", role: "employee" }, html: "x" }] });
    try {
      const r = await readThreads(apiWith(access_token, 26), {}, { since: new Date("2026-09-01T00:00:00Z"), now: new Date("2026-11-04T12:00:00Z") });
      const item = r.items.find((i) => i.read.thread.id === "9003")!;
      expect(item.read.sensitive).toBe(true);
      expect(item.read.messages).toEqual([]);
    } finally {
      mock.state.threads.pop();
    }
  });
});

describe("mapping", () => {
  const web = "https://www.aula.dk/portal/";

  it("a message becomes an email-like source with thread key, sender, recipients, institution and child", () => {
    const t = threadOf({
      id: 9001, subject: "Forældremøde", sensitive: false, latestMessage: { id: "m1", sendDateTime: "2026-10-20T08:15:00+02:00" },
      recipients: [{ fullName: "Anna Hansen", mailBoxOwner: { profileType: "guardian" } }, { fullName: "Mette Jensen", mailBoxOwner: { profileType: "employee" } }],
      regardingChildren: [{ displayName: "Emma Hansen" }], institutionName: "Bakkeskolen",
    })!;
    const m = messageOf({ id: "m1", messageType: "Message", sendDateTime: "2026-10-20T08:15:00+02:00", text: { html: "<p>Møde <b>torsdag</b></p>" }, sender: { fullName: "Mette Jensen", metadata: "Klasselærer", profileId: 501, mailBoxOwner: { profileType: "employee" } } })!;
    const s = messageSource(t, m, web);
    expect(s).toMatchObject({ externalId: "aula:msg:m1", kind: "email", threadKey: "aula:thread:9001", title: "Forældremøde", url: "https://www.aula.dk/portal/#/beskeder/9001", precision: "minute" });
    expect(s.documentDate?.toISOString()).toBe("2026-10-20T06:15:00.000Z");
    expect(s.text).toContain("From: Mette Jensen (Klasselærer)");
    expect(s.text).toContain("To: Anna Hansen");
    expect(s.text).toContain("About: Emma Hansen");
    expect(s.text).toContain("Institution: Bakkeskolen");
    expect(s.text).toContain("Møde torsdag");
    expect((s.meta.aula as { sender: { role: string } }).sender.role).toBe("staff");
    expect(messageOf({ id: "x", messageType: "RecipientAdded" })).toBeNull();
  });

  it("calendar events: lessons left out, a reply deadline becomes a reminder, children are involved", () => {
    expect(eventOf({ id: 1, type: "lesson", title: "Dansk", startDateTime: "2026-11-05T08:00:00+01:00" })).toBeNull();
    const e = eventOf({ id: 7001, type: "event", title: "Skole-hjem-samtale", startDateTime: "2026-11-18T15:00:00+01:00", endDateTime: "2026-11-18T15:20:00+01:00", responseRequired: true, responseDeadline: "2026-11-10T23:59:00+01:00", belongsToProfiles: [1101], primaryResource: { name: "3.A" } })!;
    const ops = eventOps({ e, sourceId: "s1", nodeId: "n1", nodeExists: false, changed: true, childNodeIds: ["emma"], visibility: "parents", now: new Date("2026-11-04T12:00:00Z"), relations: new Set(["involves"]), url: "u", kinds: new Set(["event:school_event"]) });
    expect(ops.map((o) => o.op)).toEqual(["addNode", "addEdge", "addReminder"]);
    expect(ops[0]).toMatchObject({ kind: "school_event", label: "Skole-hjem-samtale", receipt: { sourceId: "s1", locator: { aula: { eventId: "7001" } } } });
    expect(ops[2]).toMatchObject({ op: "addReminder", dueAt: "2026-11-09T22:59:00.000Z", aboutNodeId: "emma" });
    // Unchanged and already in the graph: nothing.
    expect(eventOps({ e, sourceId: "s1", nodeId: "n1", nodeExists: true, changed: false, childNodeIds: [], visibility: "parents", now: new Date("2026-11-04T12:00:00Z"), relations: new Set(), url: null, kinds: new Set() })).toEqual([]);
  });

  it("presence: pick-up and sick days become dated items; an ordinary day doesn't", () => {
    const child = { id: 1101, name: "Emma" };
    expect(presenceSource({ status: 3, exitTime: "15:30", exitWith: "Mormor" }, child, "2026-11-04", web)?.title).toBe("Emma: pick-up at 15:30 by Mormor");
    expect(presenceSource({ status: 1 }, child, "2026-11-04", web)).toMatchObject({ title: "Emma: sick", sensitive: true, precision: "day" });
    expect(presenceSource({ status: 8, checkOutTime: "14:02", exitWith: "Far" }, child, "2026-11-04", web)?.title).toBe("Emma: went home at 14:02 with Far");
    expect(presenceSource({ status: 3, checkInTime: "07:50" }, child, "2026-11-04", web)).toBeNull();
  });

  it("gallery albums are links only (no picture addresses kept)", () => {
    const s = albumSource({ id: "4001", title: "Udflugt", at: new Date("2026-10-15"), count: 3, creator: "Lars" }, web, ["40011", "40012"]);
    expect(s.url).toBe("https://www.aula.dk/portal/#/galleri/album/4001");
    expect(s.meta.linkOnly).toBe(true);
    expect(JSON.stringify(s)).not.toContain("presigned");
  });

  it("matches Aula's full names to the graph's people", () => {
    const people: KnownNode[] = [{ id: "e", type: "person", label: "Emma", aliases: [] }, { id: "o", type: "person", label: "Oskar Hansen", aliases: [] }];
    expect(matchPerson("Emma Louise Hansen", people)?.id).toBe("e");
    expect(matchPerson("Oskar Peter Hansen", people)?.id).toBe("o");
    expect(matchPerson("Ida Holm", people)).toBeUndefined();
  });

  it("proposes children, their school, and the staff and parents who write, each once, with receipts", () => {
    const account = accountFrom({ profiles: [{ profileId: 42, displayName: "Anna Hansen", children: [{ id: 1101, name: "Emma Hansen", institutionProfile: { id: 1101, institutionName: "Bakkeskolen", institutionCode: "G1" } }] }] });
    expect(scopeIds(account)).toEqual([1101]);
    let n = 0;
    const base = {
      account, known: [{ id: "emma", type: "person", label: "Emma", aliases: [] }] as KnownNode[], mapping: {}, existing: new Set<string>(), existingEdges: new Set<string>(),
      sourceIdFor: (x: string) => (x === "aula:msg:m1" ? "src1" : undefined), accountSourceId: "src0",
      relations: new Set(["attends", "teacher_of"]), kinds: new Set(["person:teacher", "place:school", "person:childs_friend_parent"]),
      visibility: "parents" as const, now: new Date("2026-11-04T12:00:00Z"), mint: () => `new${++n}`,
      seen: [
        { key: "profile:501", name: "Mette Jensen", role: "staff" as const, hint: "Klasselærer", institution: "Bakkeskolen", children: ["Emma Hansen"], sourceExternalId: "aula:msg:m1", quote: "Kære forældre", locator: { aula: { threadId: "9001", messageId: "m1" } } },
        { key: "profile:42", name: "Anna Hansen", role: "guardian" as const, hint: null, institution: null, children: [], sourceExternalId: "aula:msg:m1", quote: "x", locator: {} },
      ],
    };
    const r = peopleOps(base);
    expect(r.childNodes.get(1101)).toBe("emma");
    const added = r.changes.filter((c) => c.op === "addNode") as { label: string; kind: string | null; receipt?: { sourceId?: string } }[];
    expect(added.map((a) => [a.label, a.kind])).toEqual([["Bakkeskolen", "school"], ["Mette Jensen", "teacher"]]);
    expect(added[1].receipt?.sourceId).toBe("src1");
    const edges = r.changes.filter((c) => c.op === "addEdge") as { relation: string; fromId: string; toId: string; status: string }[];
    expect(edges.map((e) => [e.relation, e.status])).toEqual([["attends", "confirmed"], ["teacher_of", "unconfirmed"]]);
    // The next run, with the proposal still waiting: nothing is proposed again.
    const again = peopleOps({ ...base, mapping: r.mapping });
    expect(again.changes).toEqual([]);
    // Once delivered, the people exist; a connection someone declined isn't proposed again either.
    const delivered = new Set(Object.values(r.mapping).map((m) => m.nodeId).filter(Boolean));
    expect(peopleOps({ ...base, mapping: again.mapping, existing: delivered }).changes).toEqual([]);
  });
});

describe("posts, calendar, presence and gallery against the mock", () => {
  it("reads each once, in Aula's own formats", async () => {
    const { access_token } = mintTokens(mock.state);
    const api = apiWith(access_token, 26);
    const account = accountFrom(await api.profilesByLogin());
    const scope = scopeIds(account);
    const posts = await readPosts(api, {}, scope, new Date("2026-09-01T00:00:00Z"));
    expect(posts.posts.map((p) => p.title)).toEqual(["Motionsdag fredag"]);
    expect((await readPosts(api, posts.next, scope, new Date("2026-09-01T00:00:00Z"))).posts).toEqual([]);
    const events = await readCalendar(api, scope, new Date("2026-11-04T12:00:00Z"));
    expect(events.map((e) => e.title)).toEqual(["Skole-hjem-samtale"]);
    expect(mock.state.calls.filter((c) => c.method === "calendar.getEventsByProfileIdsAndResourceIds").every((c) => c.httpMethod === "POST")).toBe(true);
    const presence = await readPresence(api, account);
    expect(presence).toHaveLength(1);
    const gallery = await readGallery(api, scope, new Set());
    expect(gallery[0]).toMatchObject({ album: { id: "4001", title: "Udflugt til skoven" }, mediaIds: ["40011", "40012", "40013"] });
    expect(await readGallery(api, scope, new Set(["4001"]))).toEqual([]);
  });

  it("asks for the calendar in windows of at most 49 days in Copenhagen time", () => {
    const w = calendarWindows(new Date("2026-11-04T12:00:00Z"));
    expect(w.length).toBe(2);
    expect(w[0].start).toBe("2026-10-28 00:00:00.0000+0100");
    for (const x of w) expect(x.to.getTime() - x.from.getTime()).toBeLessThanOrEqual(49 * 86_400_000 + 3600_000);
    expect(aulaTs(new Date("2026-07-01T10:00:00Z"))).toBe("2026-07-01 12:00:00.0000+0200");
  });

  it("reads cookies from joined Set-Cookie headers (dates with commas included)", () => {
    expect(cookiesFrom("Csrfp-Token=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure, PHPSESSID=xyz; HttpOnly")).toEqual([["Csrfp-Token", "abc"], ["PHPSESSID", "xyz"]]);
  });
});

describe("the Connect Aula helper (one-file node script)", () => {
  it("signs in through Aula's pages (mock), swaps the code for tokens at home and posts only the tokens with the pairing code", async () => {
    const { helperSource } = await import("./helper/script");
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const http = await import("node:http");
    let received: Record<string, unknown> | null = null;
    const myGraph = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        received = JSON.parse(b);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ label: "Aula: Anna Hansen", account: { name: "Anna Hansen", children: [{ name: "Emma Hansen", institution: "Bakkeskolen" }] } }));
      });
    });
    await new Promise<void>((r) => myGraph.listen(0, "127.0.0.1", () => r()));
    const port = (myGraph.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "aula-helper-"));
    const file = join(dir, "connect-aula.mjs");
    writeFileSync(file, helperSource(`http://127.0.0.1:${port}`, "en"));
    const child = spawn(process.execPath, [file, "--code", "ABCDE-FGHJK", "--auth-base", mock.url, "--no-open"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let pasted = false;
    const done = new Promise<number>((r) => child.on("close", (c) => r(c ?? 1)));
    child.stdout.on("data", async (d: Buffer) => {
      out += d.toString();
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/simplesaml\/module\.php\/oidc\/authorize\.php\?\S+)/);
      if (m && !pasted && out.includes("paste it here")) {
        pasted = true;
        // The browser part: Aula and MitID (mocked) send the browser back to the app address with a one-time code.
        const res = await fetch(m[1], { redirect: "manual" });
        child.stdin.write(`${res.headers.get("location")}\n`);
      }
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const code = await done;
    myGraph.close();
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("Done. My Graph is connected to Aula as Anna Hansen.");
    expect(received).toMatchObject({ pairingCode: "ABCDE-FGHJK", aulaBase: mock.url });
    expect(Object.keys(received!).sort()).toEqual(["accessToken", "aulaBase", "expiresIn", "pairingCode", "refreshToken"]);
    expect(mock.state.tokens.has((received as unknown as { accessToken: string }).accessToken)).toBe(true);
    expect(out).not.toContain((received as unknown as { accessToken: string }).accessToken);
    expect(readdirSync(dir)).toEqual(["connect-aula.mjs"]);
  }, 20_000);

  it("refuses to send tokens to a plain http:// My Graph that isn't this computer", async () => {
    const { helperSource } = await import("./helper/script");
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "aula-helper-")), "connect-aula.mjs");
    writeFileSync(file, helperSource("http://mygraph.example", "da"));
    const r = spawnSync(process.execPath, [file, "--code", "X"], { input: "", encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("skal starte med https://");
  });
});
