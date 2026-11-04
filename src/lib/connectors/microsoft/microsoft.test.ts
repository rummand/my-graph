import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { deps, fakeApi, fakeCtx, memorySink, rawMail, runLikeTheApp } from "../oauth/testing";
import { microsoftConfig, microsoftManifest, syncMicrosoft, syncMicrosoftCalendar, syncMicrosoftMail, syncOneDrive } from "./connector";
import { deltaNext, driveFiles, graphEvent, graphResetSignal, graphUtc, sameApi } from "./map";

const GRAPH = "https://graph.microsoft.com/v1.0";

describe("microsoft mapping", () => {
  it("is a valid manifest", () => expect(validateManifest(microsoftManifest)).toEqual({ ok: true }));

  it("knows the start-again signals", () => {
    expect(graphResetSignal(410, "")).toBe("410");
    expect(graphResetSignal(400, JSON.stringify({ error: { code: "SyncStateNotFound" } }))).toBe("syncStateNotFound");
    expect(graphResetSignal(400, JSON.stringify({ error: { code: "resyncRequired" } }))).toBe("syncStateNotFound");
    expect(graphResetSignal(400, JSON.stringify({ error: { code: "badRequest" } }))).toBeNull();
    expect(graphResetSignal(500, "")).toBeNull();
  });

  it("follows delta links only back to Graph", () => {
    expect(sameApi(`${GRAPH}/me/messages/delta?$deltatoken=x`, GRAPH)).toBe(true);
    expect(sameApi("https://evil.example/v1.0/me", GRAPH)).toBe(false);
    expect(sameApi("https://graph.microsoft.com/beta/me", GRAPH)).toBe(false);
    expect(deltaNext({ "@odata.nextLink": "n" })).toEqual({ next: "n" });
    expect(deltaNext({ "@odata.deltaLink": "d" })).toEqual({ delta: "d" });
  });

  it("reads UTC times and maps events", () => {
    expect(graphUtc({ dateTime: "2026-11-20T16:00:00.0000000", timeZone: "UTC" })?.toISOString()).toBe("2026-11-20T16:00:00.000Z");
    const e = graphEvent({ id: "A", iCalUId: "ical-1", subject: "Lægetid", start: { dateTime: "2026-11-20T08:00:00.0000000" }, end: { dateTime: "2026-11-20T08:30:00.0000000" }, location: { displayName: "Lægehuset" }, type: "singleInstance" });
    expect(e).toMatchObject({ key: "ical-1", summary: "Lægetid", location: "Lægehuset", providerId: "mscal:A", allDay: false });
    expect(graphEvent({ id: "B", isAllDay: true, iCalUId: "i2", subject: "Ferie", start: { dateTime: "2026-12-24T00:00:00.0000000" } })).toMatchObject({ allDay: true, date: "2026-12-24" });
    expect(graphEvent({ id: "C", "@removed": { reason: "deleted" } })).toEqual({ removed: "mscal:C" });
    expect(graphEvent({ id: "D", type: "seriesMaster", start: { dateTime: "2026-01-01T00:00:00" } })).toBeNull();
    expect(graphEvent({ id: "E", isCancelled: true, iCalUId: "i5", subject: "Aflyst", start: { dateTime: "2026-12-01T10:00:00" } })).toMatchObject({ status: "cancelled" });
  });

  it("keeps only files from a OneDrive delta page", () => {
    expect(driveFiles([{ id: "1", name: "a.pdf", file: {} }, { id: "2", name: "f", folder: {} }, { id: "3", name: "b.pdf", file: {}, deleted: {} }]).map((i) => i.id)).toEqual(["1"]);
  });
});

function graphServer() {
  const s = { mailExpired: false, calExpired: false, newMail: [] as string[], deltaCalls: 0, location: "" };
  const mime = (id: string) => rawMail({ id, subject: `Besked ${id}` });
  const api = fakeApi(({ u, url }) => {
    const p = u.pathname.replace("/v1.0", "");
    if (p === "/me/mailFolders/inbox/messages/delta") {
      if (u.searchParams.get("$deltatoken")) {
        if (s.mailExpired) return { status: 410, json: { error: { code: "SyncStateNotFound" } } };
        return { json: { value: s.newMail.map((id) => ({ id, conversationId: "conv-2" })), "@odata.deltaLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=2` } };
      }
      if (u.searchParams.get("$skiptoken")) return { json: { value: [{ id: "m3", conversationId: "conv-2" }, { id: "gone", "@removed": { reason: "deleted" } }], "@odata.deltaLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=1` } };
      return { json: { value: [{ id: "m1", conversationId: "conv-1" }, { id: "m2", conversationId: "conv-1" }], "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=a` } };
    }
    const msg = p.match(/^\/me\/messages\/(\w+)\/\$value$/);
    if (msg) return { body: mime(msg[1]) };
    if (p === "/me/calendarView/delta") {
      s.deltaCalls++;
      if (u.searchParams.get("$deltatoken")) {
        if (s.calExpired) return { status: 400, json: { error: { code: "resyncRequired" } } };
        return { json: { value: [{ id: "ev1", "@removed": { reason: "deleted" } }], "@odata.deltaLink": `${GRAPH}/me/calendarView/delta?$deltatoken=c2` } };
      }
      return { json: { value: [{ id: "ev1", iCalUId: "i1", subject: "Skolefest", start: { dateTime: "2026-11-28T15:00:00.0000000" } }], "@odata.deltaLink": `${GRAPH}/me/calendarView/delta?$deltatoken=c1` } };
    }
    if (p === "/me/drive/items/F1/delta") {
      return { json: { value: [{ id: "F1", name: "Familie", folder: {} }, { id: "d1", name: "Forsikring.pdf", file: { mimeType: "application/pdf" }, cTag: "c1", size: 10 }], "@odata.deltaLink": `${GRAPH}/me/drive/items/F1/delta?token=t1` } };
    }
    if (p === "/me/drive/items/d1/content") return { status: 302, headers: { location: "https://public.example/dl/d1?sig=x" } };
    if (url.startsWith("https://public.example/dl/d1")) return { body: "%PDF-1.4 x" };
    return undefined;
  });
  return { api, s };
}

describe("microsoft sync", () => {
  const cfg = microsoftConfig.parse({ driveFolders: [{ id: "F1", name: "Familie" }] });

  it("reads mail page by page with delta, then only what is new; MIME originals with the conversation as thread", async () => {
    const g = graphServer();
    const sink = memorySink();
    const ctx = fakeCtx("microsoft", cfg);
    await syncMicrosoftMail(ctx, deps(g.api, sink));
    expect(sink.rec.mail.map((m) => [m.providerId, m.threadKey])).toEqual([["outlook:m1", "outlook:conv-1"], ["outlook:m2", "outlook:conv-1"], ["outlook:m3", "outlook:conv-2"]]);
    expect(sink.rec.mail[0].raw.toString()).toContain("Subject: Besked m1");
    expect(g.api.calls[0].url).toContain("receivedDateTime+ge+2026-08-06");
    expect(ctx.state().streams?.mail?.cursor).toMatchObject({ folders: { inbox: { link: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=1`, done: true } } });
    g.s.newMail = ["m4", "m3"];
    sink.rec.knownMail.add("outlook:m3");
    await syncMicrosoftMail(ctx, deps(g.api, sink));
    expect(sink.rec.mail.map((m) => m.providerId)).toEqual(["outlook:m1", "outlook:m2", "outlook:m3", "outlook:m4"]);
  });

  it("starts the mail again on 410 SyncStateNotFound", async () => {
    const g = graphServer();
    g.s.mailExpired = true;
    const sink = memorySink();
    const ctx = fakeCtx("microsoft", cfg, { streams: { mail: { cursor: { folders: { inbox: { link: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=old` } } } } } });
    const r = await runLikeTheApp(ctx, syncMicrosoftMail, deps(g.api, sink));
    expect(r.reset).toBe("mail:410");
    expect(sink.rec.mail).toHaveLength(3);
  });

  it("refuses to follow a saved link that doesn't point at Graph", async () => {
    const g = graphServer();
    const ctx = fakeCtx("microsoft", cfg, { streams: { mail: { cursor: { folders: { inbox: { link: "https://evil.example/steal" } } } } } });
    const r = await runLikeTheApp(ctx, syncMicrosoftMail, deps(g.api, memorySink()));
    expect(r.reset).toBe("mail:syncStateNotFound");
    expect(g.api.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });

  it("reads the calendar view with delta (in UTC), removed events, and resyncRequired", async () => {
    const g = graphServer();
    const sink = memorySink();
    const ctx = fakeCtx("microsoft", cfg);
    await syncMicrosoftCalendar(ctx, deps(g.api, sink));
    expect(sink.rec.events.map((e) => [e.key, e.start.toISOString()])).toEqual([["i1", "2026-11-28T15:00:00.000Z"]]);
    expect(g.api.calls[0].headers?.prefer).toContain('outlook.timezone="UTC"');
    await syncMicrosoftCalendar(ctx, deps(g.api, sink));
    expect(sink.rec.removed).toEqual(["mscal:ev1"]);
    g.s.calExpired = true;
    const r = await runLikeTheApp(ctx, syncMicrosoftCalendar, deps(g.api, sink));
    expect(r.reset).toBe("calendar:syncStateNotFound");
    expect(sink.rec.events).toHaveLength(2);
  });

  it("starts a fresh calendar window when the old one runs out within a year", async () => {
    const g = graphServer();
    const ctx = fakeCtx("microsoft", cfg, { streams: { calendar: { cursor: { link: `${GRAPH}/me/calendarView/delta?$deltatoken=c1`, windowEnd: "2027-03-01T00:00:00Z" } } } });
    const r = await runLikeTheApp(ctx, syncMicrosoftCalendar, deps(g.api, memorySink()));
    expect(r.reset).toBe("calendar:window");
    expect(new URL(g.api.calls[0].url).searchParams.get("endDateTime")).toBe("2028-11-03T10:00:00.000Z");
  });

  it("downloads OneDrive files from the pre-signed address without the token, and skips unchanged ones", async () => {
    const g = graphServer();
    const sink = memorySink();
    const ctx = fakeCtx("microsoft", cfg);
    await syncOneDrive(ctx, deps(g.api, sink));
    expect(sink.rec.files.map((f) => [f.externalId, f.name, f.version])).toEqual([["onedrive:d1", "Forsikring.pdf", "c1"]]);
    const dl = g.api.calls.find((c) => c.url.startsWith("https://public.example"));
    expect(dl?.noAuth).toBe(true);
    await syncOneDrive(fakeCtx("microsoft", cfg), deps(g.api, sink));
    expect(sink.rec.files).toHaveLength(1);
  });

  it("runs only the streams that are switched on", async () => {
    const g = graphServer();
    await syncMicrosoft(fakeCtx("microsoft", microsoftConfig.parse({ mail: false, calendar: true })), deps(g.api, memorySink()));
    expect(g.api.calls.every((c) => c.url.includes("calendarView"))).toBe(true);
  });
});
