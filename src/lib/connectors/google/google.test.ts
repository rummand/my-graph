import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { b64url, deps, fakeApi, fakeCtx, memorySink, rawMail, runLikeTheApp } from "../oauth/testing";
import { googleCalendarConfig, googleCalendarManifest, syncGoogleCalendar, type GoogleCalendarCursor } from "./calendar";
import { googleDriveConfig, googleDriveManifest, syncGoogleDrive } from "./drive";
import { gmailConfig, gmailManifest, syncGmail } from "./gmail";
import { driveExport, driveInScope, driveName, driveVersion, gmailAfter, gmailRaw, gmailWanted, googleEvent, historyMessages, FOLDER_MIME } from "./map";

const G = "https://gmail.googleapis.com/gmail/v1/users/me";

describe("google manifests", () => {
  it("are valid", () => {
    for (const m of [gmailManifest, googleCalendarManifest, googleDriveManifest]) expect(validateManifest(m), m.id).toEqual({ ok: true });
  });
});

describe("gmail mapping", () => {
  it("decodes raw messages and filters labels", () => {
    expect(gmailRaw(b64url("Subject: æøå?>>")).toString()).toBe("Subject: æøå?>>");
    expect(gmailWanted(["INBOX", "UNREAD"], ["INBOX"])).toBe(true);
    expect(gmailWanted(["Label_1"], ["INBOX"])).toBe(false);
    expect(gmailWanted(["INBOX", "SPAM"], [])).toBe(false);
    expect(gmailWanted(["CATEGORY_UPDATES"], [])).toBe(true);
    expect(gmailAfter(new Date("2026-08-01T00:00:00Z"))).toBe("after:2026/08/01");
  });

  it("reads new and newly labelled messages from a history page, once each", () => {
    const page = {
      history: [
        { messagesAdded: [{ message: { id: "a", threadId: "t1", labelIds: ["INBOX"] } }, { message: { id: "b", threadId: "t2", labelIds: ["SENT"] } }] },
        { labelsAdded: [{ message: { id: "c", threadId: "t3", labelIds: ["Label_9"] }, labelIds: ["Label_9"] }] },
        { messagesAdded: [{ message: { id: "a", threadId: "t1", labelIds: ["INBOX"] } }] },
      ],
    };
    expect(historyMessages(page, ["INBOX", "Label_9"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(historyMessages(page, []).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

/** A tiny Gmail: messages with labels and a history that moves on. */
function gmailServer() {
  const msgs = new Map<string, { threadId: string; labels: string[]; raw: string }>();
  for (let i = 1; i <= 5; i++) msgs.set(`m${i}`, { threadId: i < 3 ? "t1" : `t${i}`, labels: i === 5 ? ["Label_x"] : ["INBOX"], raw: rawMail({ id: `m${i}`, subject: `Brev ${i}` }) });
  const state = { historyId: "100", history: [] as { id: string; threadId: string; labelIds: string[] }[], expired: false, listed: [] as string[] };
  const api = fakeApi(({ u }) => {
    const p = u.pathname.replace("/gmail/v1/users/me", "");
    if (p === "/profile") return { json: { emailAddress: "anna@gmail.com", historyId: state.historyId } };
    if (p === "/messages") {
      state.listed.push(u.search);
      const label = u.searchParams.get("labelIds");
      const all = [...msgs].filter(([, m]) => !label || m.labels.includes(label)).map(([id, m]) => ({ id, threadId: m.threadId }));
      // Two per page.
      const start = Number(u.searchParams.get("pageToken") ?? 0);
      const slice = all.slice(start, start + 2);
      return { json: { messages: slice, ...(start + 2 < all.length ? { nextPageToken: String(start + 2) } : {}) } };
    }
    const one = p.match(/^\/messages\/(\w+)$/);
    if (one) {
      const m = msgs.get(one[1]);
      return m ? { json: { id: one[1], threadId: m.threadId, labelIds: m.labels, raw: b64url(m.raw) } } : { status: 404, json: {} };
    }
    if (p === "/history") {
      if (state.expired) return { status: 404, json: { error: { code: 404, message: "Requested entity was not found." } } };
      return { json: { history: state.history.map((m) => ({ messagesAdded: [{ message: m }] })), historyId: state.historyId } };
    }
    return undefined;
  });
  return { api, msgs, state };
}

describe("gmail sync", () => {
  it("notes the history id first, reads the chosen labels page by page, then follows the history", async () => {
    const g = gmailServer();
    const sink = memorySink();
    const ctx = fakeCtx("gmail", gmailConfig.parse({ labels: ["INBOX"], since: "2026-08-01" }));
    await runLikeTheApp(ctx, syncGmail, deps(g.api, sink));
    expect(g.api.calls[0].url).toBe(`${G}/profile`);
    expect(sink.rec.mail.map((m) => m.providerId)).toEqual(["gmail:m1", "gmail:m2", "gmail:m3", "gmail:m4"]);
    expect(sink.rec.mail[0].threadKey).toBe("gmail:t1");
    expect(sink.rec.mail[1].threadKey).toBe("gmail:t1");
    expect(sink.rec.mail[0].raw.toString()).toContain("Subject: Brev 1");
    expect(g.state.listed[0]).toContain("q=after%3A2026%2F08%2F01");
    expect(ctx.state().streams?.mail?.cursor).toEqual({ historyId: "100" });

    // New mail arrives: only it is fetched.
    g.msgs.set("m6", { threadId: "t1", labels: ["INBOX"], raw: rawMail({ id: "m6", subject: "Svar", inReplyTo: "m1" }) });
    g.state.history = [{ id: "m6", threadId: "t1", labelIds: ["INBOX"] }, { id: "m1", threadId: "t1", labelIds: ["INBOX"] }];
    g.state.historyId = "140";
    const before = g.api.calls.length;
    await runLikeTheApp(ctx, syncGmail, deps(g.api, sink));
    const urls = g.api.calls.slice(before).map((c) => new URL(c.url).pathname);
    expect(urls).toEqual(["/gmail/v1/users/me/history", "/gmail/v1/users/me/messages/m6"]);
    expect(sink.rec.mail.at(-1)?.providerId).toBe("gmail:m6");
    expect(ctx.state().streams?.mail?.cursor).toEqual({ historyId: "140" });
  });

  it("starts again from the start date when Gmail says the history id is too old (404), skipping what it has", async () => {
    const g = gmailServer();
    const sink = memorySink();
    const ctx = fakeCtx("gmail", gmailConfig.parse({ labels: ["INBOX"] }), { streams: { mail: { cursor: { historyId: "5" } } } });
    sink.rec.knownMail.add("gmail:m1");
    sink.rec.knownMail.add("gmail:m2");
    g.state.expired = true;
    const r = await runLikeTheApp(ctx, async (c, d) => { try { await syncGmail(c, d); } finally { g.state.expired = false; } }, deps(g.api, sink));
    expect(r.reset).toBe("mail:404");
    expect(ctx.state().streams?.mail?.resets).toBe(1);
    // The since date: 90 days before "now" (2026-11-04) when none was chosen.
    expect(g.state.listed[0]).toContain("after%3A2026%2F08%2F06");
    expect(sink.rec.mail.map((m) => m.providerId)).toEqual(["gmail:m3", "gmail:m4"]);
    expect(g.api.calls.some((c) => c.url.endsWith("/messages/m1?format=raw"))).toBe(false);
    expect(ctx.counts.mail.unchanged).toBe(2);
  });

  it("with no label chosen reads all mail; one label at a time otherwise", async () => {
    const g = gmailServer();
    const sink = memorySink();
    await runLikeTheApp(fakeCtx("gmail", gmailConfig.parse({ labels: [] })), syncGmail, deps(g.api, sink));
    expect(sink.rec.mail).toHaveLength(5);
    const g2 = gmailServer();
    const sink2 = memorySink();
    await runLikeTheApp(fakeCtx("gmail", gmailConfig.parse({ labels: ["INBOX", "Label_x"] })), syncGmail, deps(g2.api, sink2));
    expect(sink2.rec.mail.map((m) => m.providerId).sort()).toEqual(["gmail:m1", "gmail:m2", "gmail:m3", "gmail:m4", "gmail:m5"]);
    expect(g2.state.listed.filter((s) => s.includes("labelIds=Label_x"))).toHaveLength(1);
  });

  it("asks the person when the mailbox can't be read", async () => {
    const api = fakeApi(() => ({ status: 403, json: { error: "forbidden" } }));
    await expect(syncGmail(fakeCtx("gmail", gmailConfig.parse({})), deps(api, memorySink()))).rejects.toMatchObject({ kind: "needs_you" });
  });
});

describe("calendar mapping", () => {
  it("maps timed, all-day, cancelled and repeating events", () => {
    const timed = googleEvent({ id: "e1", iCalUID: "uid-1@google.com", summary: "Forældremøde", location: "Skolen", start: { dateTime: "2026-11-20T17:00:00+01:00" }, end: { dateTime: "2026-11-20T18:30:00+01:00" }, htmlLink: "https://calendar.google.com/x" });
    expect(timed).toMatchObject({ key: "uid-1@google.com", uid: "uid-1@google.com", summary: "Forældremøde", location: "Skolen", allDay: false, providerId: "gcal:e1" });
    expect((timed as { start: Date }).start.toISOString()).toBe("2026-11-20T16:00:00.000Z");
    const day = googleEvent({ id: "e2", iCalUID: "u2", summary: "Lukkedag", start: { date: "2026-12-23" }, end: { date: "2026-12-24" } });
    expect(day).toMatchObject({ allDay: true, date: "2026-12-23" });
    expect(googleEvent({ id: "e3", status: "cancelled" })).toEqual({ removed: "gcal:e3" });
    const occ = googleEvent({ id: "e4_20261105", iCalUID: "series@google.com", summary: "Svømning", recurringEventId: "e4", originalStartTime: { dateTime: "2026-11-05T15:00:00Z" }, start: { dateTime: "2026-11-05T15:00:00Z" } });
    expect(occ).toMatchObject({ key: "series@google.com#2026-11-05T15:00:00.000Z", recurring: true });
    expect(googleEvent({ id: "x" })).toBeNull();
  });
});

function calendarServer() {
  const s = { token: "sync-1", expired: false, changes: [] as unknown[], calls: 0 };
  const events = [
    { id: "e1", iCalUID: "u1", summary: "Juleklip", start: { dateTime: "2026-12-01T13:00:00Z" }, end: { dateTime: "2026-12-01T14:00:00Z" } },
    { id: "e2", iCalUID: "u2", summary: "Old", start: { dateTime: "2020-01-01T10:00:00Z" } },
    { id: "e3", iCalUID: "u3", summary: "Fødselsdag", start: { date: "2026-11-30" }, end: { date: "2026-12-01" } },
  ];
  const api = fakeApi(({ u }) => {
    if (u.pathname.endsWith("/calendarList/primary")) return { json: { id: "anna@gmail.com", summary: "Anna" } };
    if (u.pathname.endsWith("/calendars/primary/events")) {
      s.calls++;
      const sync = u.searchParams.get("syncToken");
      if (sync) {
        if (s.expired) return { status: 410, json: { error: { code: 410, message: "Sync token is no longer valid" } } };
        return { json: { items: s.changes, nextSyncToken: `${sync}+` } };
      }
      const page = u.searchParams.get("pageToken");
      return page ? { json: { items: events.slice(2), nextSyncToken: s.token } } : { json: { items: events.slice(0, 2), nextPageToken: "p2" } };
    }
    return undefined;
  });
  return { api, s };
}

describe("google calendar sync", () => {
  it("reads all pages the first time, keeps the sync token, then reads only changes (cancelled ones as removed)", async () => {
    const c = calendarServer();
    const sink = memorySink();
    const ctx = fakeCtx("google_calendar", googleCalendarConfig.parse({}));
    await runLikeTheApp(ctx, syncGoogleCalendar, deps(c.api, sink));
    expect(sink.rec.events.map((e) => e.key)).toEqual(["u1", "u3"]); // the 2020 event is outside the window
    expect((ctx.state().streams?.events?.cursor as GoogleCalendarCursor).calendars?.primary).toEqual({ name: "Anna", syncToken: "sync-1", pageToken: null });
    c.s.changes = [{ id: "e1", status: "cancelled" }, { id: "e9", iCalUID: "u9", summary: "Ny aftale", start: { dateTime: "2026-11-10T08:00:00Z" } }];
    await runLikeTheApp(ctx, syncGoogleCalendar, deps(c.api, sink));
    expect(sink.rec.removed).toEqual(["gcal:e1"]);
    expect(sink.rec.events.at(-1)?.key).toBe("u9");
    expect((ctx.state().streams?.events?.cursor as GoogleCalendarCursor).calendars?.primary?.syncToken).toBe("sync-1+");
    expect(c.api.calls.at(-1)?.url).toContain("syncToken=sync-1");
  });

  it("reads everything again when the sync token expired (410)", async () => {
    const c = calendarServer();
    c.s.expired = true;
    const sink = memorySink();
    const ctx = fakeCtx("google_calendar", googleCalendarConfig.parse({}), { streams: { events: { cursor: { calendars: { primary: { name: "Anna", syncToken: "stale" } } } } } });
    const r = await runLikeTheApp(ctx, syncGoogleCalendar, deps(c.api, sink));
    expect(r.reset).toBe("events:410");
    expect(sink.rec.events.map((e) => e.key)).toEqual(["u1", "u3"]);
    expect(ctx.state().streams?.events?.resets).toBe(1);
  });
});

describe("drive mapping", () => {
  it("exports Google formats and downloads the rest", () => {
    expect(driveExport("application/vnd.google-apps.document")).toMatchObject({ ext: "docx" });
    expect(driveExport("application/vnd.google-apps.spreadsheet")).toMatchObject({ ext: "xlsx" });
    expect(driveExport("application/vnd.google-apps.form")).toBeNull();
    expect(driveExport(FOLDER_MIME)).toBeNull();
    expect(driveExport("application/pdf")).toBe("download");
    expect(driveName({ name: "Madplan" }, { ext: "xlsx" })).toBe("Madplan.xlsx");
    expect(driveName({ name: "brev.pdf" }, "download")).toBe("brev.pdf");
    expect(driveVersion({ id: "1", name: "x", mimeType: "a", md5Checksum: "abc", version: "7" })).toBe("abc");
    expect(driveVersion({ id: "1", name: "x", mimeType: "a", version: "7" })).toBe("v7");
    expect(driveInScope({ id: "f", parents: ["fold"] }, new Set(), new Set(["fold"]))).toBe(true);
    expect(driveInScope({ id: "f", parents: ["other"] }, new Set(["g"]), new Set(["fold"]))).toBe(false);
  });
});

function driveServer() {
  const files: Record<string, { id: string; name: string; mimeType: string; parents?: string[]; md5Checksum?: string; version?: string }> = {
    doc: { id: "doc", name: "Madplan", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["fold"], version: "3" },
    pdf: { id: "pdf", name: "Indskrivning.pdf", mimeType: "application/pdf", parents: ["sub"], md5Checksum: "m1" },
    sub: { id: "sub", name: "Skole", mimeType: FOLDER_MIME, parents: ["fold"] },
    lone: { id: "lone", name: "Pas.pdf", mimeType: "application/pdf", md5Checksum: "p1" },
  };
  const s = { changes: [] as unknown[], expired: false, start: "tok-1" };
  const api = fakeApi(({ u }) => {
    const p = u.pathname.replace("/drive/v3", "");
    if (p === "/changes/startPageToken") return { json: { startPageToken: s.start } };
    if (p === "/changes") {
      if (s.expired) return { status: 404, json: { error: { message: "Invalid page token" } } };
      return { json: { changes: s.changes, newStartPageToken: `${u.searchParams.get("pageToken")}+` } };
    }
    if (p === "/files" && u.searchParams.get("q")) {
      const parent = u.searchParams.get("q")!.match(/'([^']+)'/)![1];
      return { json: { files: Object.values(files).filter((f) => f.parents?.includes(parent)) } };
    }
    const exp = p.match(/^\/files\/(\w+)\/export$/);
    if (exp) return { body: Buffer.from("PK\u0003\u0004 fake xlsx"), headers: { "content-type": "application/octet-stream" } };
    const one = p.match(/^\/files\/(\w+)$/);
    if (one && u.searchParams.get("alt") === "media") return { body: Buffer.from("%PDF-1.4 fake") };
    if (one) return files[one[1]] ? { json: files[one[1]] } : { status: 404, json: {} };
    return undefined;
  });
  return { api, s, files };
}

describe("google drive sync", () => {
  const picked = [{ id: "fold", name: "Familie", mimeType: FOLDER_MIME }, { id: "lone", name: "Pas.pdf", mimeType: "application/pdf" }];

  it("does nothing until something is picked", async () => {
    const d = driveServer();
    const ctx = fakeCtx("google_drive", googleDriveConfig.parse({}));
    await syncGoogleDrive(ctx, deps(d.api, memorySink()));
    expect(d.api.calls).toHaveLength(0);
    expect(ctx.logs[0]).toMatch(/Nothing is picked/);
  });

  it("notes the change position first, reads picked folders (and folders inside) and files, exporting Sheets as Excel", async () => {
    const d = driveServer();
    const sink = memorySink();
    const ctx = fakeCtx("google_drive", googleDriveConfig.parse({ picked }));
    await runLikeTheApp(ctx, syncGoogleDrive, deps(d.api, sink));
    expect(new URL(d.api.calls[0].url).pathname).toBe("/drive/v3/changes/startPageToken");
    expect(sink.rec.files.map((f) => [f.externalId, f.name, f.mime])).toEqual([
      ["gdrive:doc", "Madplan.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["gdrive:pdf", "Indskrivning.pdf", "application/pdf"],
      ["gdrive:lone", "Pas.pdf", "application/pdf"],
    ]);
    expect(ctx.state().streams?.files?.cursor).toMatchObject({ pageToken: "tok-1+", seeded: ["fold", "lone"], folders: ["fold", "sub"] });

    // A change inside the picked folder is read again; a change elsewhere is not; an unchanged version isn't downloaded.
    d.s.changes = [
      { fileId: "pdf", file: { ...d.files.pdf, md5Checksum: "m2" } },
      { fileId: "x", file: { id: "x", name: "Andet.pdf", mimeType: "application/pdf", parents: ["elsewhere"], md5Checksum: "z" } },
      { fileId: "lone", file: d.files.lone },
      { fileId: "gone", removed: true },
    ];
    await runLikeTheApp(ctx, syncGoogleDrive, deps(d.api, sink));
    expect(sink.rec.files.map((f) => f.externalId)).toEqual(["gdrive:doc", "gdrive:pdf", "gdrive:lone", "gdrive:pdf"]);
    expect(ctx.counts.files.updated).toBe(1);
    expect(ctx.counts.files.unchanged).toBe(1);
    expect(ctx.state().streams?.files?.cursor).toMatchObject({ pageToken: "tok-1++" });
  });

  it("reads picked items again from a new position when the saved one expired", async () => {
    const d = driveServer();
    d.s.expired = true;
    const sink = memorySink();
    const ctx = fakeCtx("google_drive", googleDriveConfig.parse({ picked }), { streams: { files: { cursor: { pageToken: "old", seeded: ["fold", "lone"], folders: ["fold", "sub"] } } } });
    const r = await runLikeTheApp(ctx, async (c, dd) => { try { await syncGoogleDrive(c, dd); } finally { d.s.expired = false; } }, deps(d.api, sink));
    expect(r.reset).toBe("files:404");
    expect(sink.rec.files).toHaveLength(3);
    expect(ctx.state().streams?.files?.cursor).toMatchObject({ seeded: ["fold", "lone"] });
  });
});
