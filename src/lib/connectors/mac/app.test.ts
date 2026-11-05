import { describe, expect, it } from "vitest";
import {
  APP_IMPORTERS, applyAppSettings, appSettingsBody, decideUpload, fileNameOf, filterUnsent, newerCalls, outboxLedger, outboxPage, parseSince,
  reconcileOutbox, sentLedger, SENT_CAP, sourceOffError, sourceOn, sourcesOf, uploadFields, type OutboxCurrent,
} from "./app";
import { macConfig } from "./config";

describe("settings and switches", () => {
  it("has every source off until the person turns it on", () => {
    const cfg = macConfig.parse({});
    expect(Object.values(sourcesOf(cfg)).every((v) => v === false)).toBe(true);
    expect(cfg.writeBack).toEqual({ reminders: false, events: false });
    expect(cfg.folders).toEqual([]);
  });

  it("applies a partial change and keeps the rest, Messages and Notes in their own place", () => {
    const cfg = macConfig.parse({ messages: { enabled: false, chats: ["A"] } });
    const body = appSettingsBody.parse({ sources: { calendar: true, messages: true }, writeBack: { reminders: true }, folders: ["Documents/Taxes", "Documents/Taxes", " School "] });
    const next = macConfig.parse(applyAppSettings(cfg, body));
    expect(next.messages).toMatchObject({ enabled: true, chats: ["A"] });
    expect(next.sources.calendar).toBe(true);
    expect(next.sources.calls).toBe(false);
    expect(next.writeBack).toEqual({ reminders: true, events: false });
    expect(next.folders).toEqual(["Documents/Taxes", "School"]);
    const again = macConfig.parse(applyAppSettings(next, appSettingsBody.parse({ sources: { calendar: false } })));
    expect(again.sources.calendar).toBe(false);
    expect(again.messages.enabled).toBe(true);
    expect(again.folders).toEqual(["Documents/Taxes", "School"]);
  });

  it("refuses unknown or empty settings", () => {
    expect(appSettingsBody.safeParse({}).success).toBe(false);
    expect(appSettingsBody.safeParse({ sources: { banking: true } }).success).toBe(false);
    expect(appSettingsBody.safeParse({ token: "x" }).success).toBe(false);
  });

  it("gates each import on its own switch", () => {
    const cfg = macConfig.parse({ sources: { calendar: true } });
    for (const [importer, source] of Object.entries(APP_IMPORTERS)) {
      expect(sourceOn(cfg, source)).toBe(importer === "calendar");
    }
    expect(sourceOffError("calls")).toMatchObject({ status: 409, code: "macSourceOff:calls" });
  });

  it("keeps the new settings when the old helper's settings are saved", () => {
    const cfg = macConfig.parse({ sources: { photos: true }, writeBack: { events: true }, folders: ["X"] });
    // updateMacChoices re-parses the whole config with the page's patch: nothing of the app's may fall out.
    const next = macConfig.parse({ ...cfg, notes: { ...cfg.notes, enabled: true } });
    expect(next.sources.photos).toBe(true);
    expect(next.writeBack.events).toBe(true);
    expect(next.folders).toEqual(["X"]);
  });
});

describe("what was sent before", () => {
  it("passes only new or changed items and remembers them", () => {
    const a = { id: "1", title: "A" }, b = { id: "2", title: "B" };
    const first = filterUnsent([a, b], (x) => x.id, {});
    expect(first.fresh).toEqual([a, b]);
    const second = filterUnsent([a, { ...b, title: "B2" }], (x) => x.id, first.next);
    expect(second.fresh).toEqual([{ id: "2", title: "B2" }]);
    expect(second.unchanged).toBe(1);
    expect(sentLedger({ sent: second.next })).toEqual(second.next);
    expect(sentLedger(null)).toEqual({});
  });

  it("keeps the ledger bounded", () => {
    const items = Array.from({ length: SENT_CAP + 10 }, (_, i) => ({ id: String(i) }));
    expect(Object.keys(filterUnsent(items, (x) => x.id, {}).next)).toHaveLength(SENT_CAP);
  });

  it("moves the calls cursor forward only", () => {
    const calls = [{ at: "2026-11-01T09:00:00Z" }, { at: "2026-11-02T09:00:00Z" }];
    const r = newerCalls(calls, null);
    expect(r.fresh).toHaveLength(2);
    expect(r.next).toBe("2026-11-02T09:00:00.000Z");
    const again = newerCalls([...calls, { at: "2026-11-03T09:00:00Z" }], r.next);
    expect(again.fresh.map((c) => c.at)).toEqual(["2026-11-02T09:00:00Z", "2026-11-03T09:00:00Z"]);
    expect(newerCalls([], "2026-11-02T09:00:00.000Z").next).toBe("2026-11-02T09:00:00.000Z");
  });
});

describe("files and versions", () => {
  it("decides by the Mac's file id first, then by the bytes", () => {
    expect(decideUpload({ sha256: "x", prev: null, sameBytes: null })).toEqual({ action: "new" });
    expect(decideUpload({ sha256: "x", prev: { id: "s1", sha256: "x" }, sameBytes: null })).toEqual({ action: "unchanged", sourceId: "s1" });
    expect(decideUpload({ sha256: "y", prev: { id: "s1", sha256: "x" }, sameBytes: { id: "other", title: "Other.pdf" } })).toEqual({ action: "version", prevId: "s1" });
    expect(decideUpload({ sha256: "x", prev: null, sameBytes: { id: "s9", title: "Copy.pdf" } })).toEqual({ action: "duplicate", of: { id: "s9", title: "Copy.pdf" } });
  });

  it("checks the upload's fields and names the file from its path", () => {
    expect(uploadFields.safeParse({ fileId: "vol1:123456", relPath: "Taxes/2025/Return.pdf", folderLabel: "Documents" }).data?.source).toBe("files");
    expect(uploadFields.safeParse({ fileId: "has space", relPath: "a", folderLabel: "b" }).success).toBe(false);
    expect(uploadFields.safeParse({ fileId: "a", relPath: "a", folderLabel: "b", source: "photos" }).success).toBe(false);
    expect(fileNameOf("Taxes/2025/Return.pdf")).toBe("Return.pdf");
    expect(fileNameOf("/")).toBe("Untitled");
  });
});

describe("write-back outbox", () => {
  const NOW = new Date("2026-11-05T12:00:00Z");
  const rem = (id: string, extra: Partial<OutboxCurrent> = {}): OutboxCurrent =>
    ({ id, kind: "reminder", title: `R ${id}`, dueAt: "2026-11-10T09:00:00.000Z", done: false, url: `https://g/?reminder=${id}`, ...extra });
  const ev = (id: string, extra: Partial<OutboxCurrent> = {}): OutboxCurrent =>
    ({ id, kind: "event", title: `E ${id}`, startAt: "2026-11-20T09:00:00.000Z", endAt: null, allDay: false, done: false, url: `https://g/node/${id}`, ...extra });

  it("hands out everything first, then only what changed, deletions included", () => {
    const current = [rem("r1"), rem("r2"), ev("e1")];
    const l1 = reconcileOutbox(outboxLedger(null), current, NOW).ledger;
    const page1 = outboxPage(l1, current, null);
    expect(page1.items.map((i) => i.id)).toEqual(["r1", "r2", "e1"]);
    expect(page1.items[2]).toMatchObject({ kind: "event", allDay: false, deleted: false, startAt: "2026-11-20T09:00:00.000Z" });
    expect(page1.cursor).toBe("3");

    // Nothing changed: same ledger, nothing new after the cursor.
    const same = reconcileOutbox(l1, current, NOW);
    expect(same.changed).toBe(false);
    expect(outboxPage(same.ledger, current, parseSince(page1.cursor, same.ledger)).items).toEqual([]);

    // r1 ticked done in My Graph, r2 deleted, a new event.
    const later = new Date(NOW.getTime() + 60_000);
    const current2 = [rem("r1", { done: true }), ev("e1"), ev("e2")];
    const l2 = reconcileOutbox(l1, current2, later).ledger;
    const page2 = outboxPage(l2, current2, parseSince(page1.cursor, l2));
    expect(page2.items.map((i) => `${i.id}:${i.done}:${i.deleted}`).sort()).toEqual(["e2:false:false", "r1:true:false", "r2:false:true"]);
    expect(page2.items.find((i) => i.id === "r2")).toMatchObject({ kind: "reminder", title: "R r2", updatedAt: later.toISOString() });
    // From the start again: no tombstones.
    expect(outboxPage(l2, current2, null).items.map((i) => i.id).sort()).toEqual(["e1", "e2", "r1"]);
  });

  it("forgets quietly what only left the window", () => {
    const current = [ev("past", { startAt: "2026-11-05T13:00:00.000Z" })];
    const l1 = reconcileOutbox(outboxLedger(null), current, NOW).ledger;
    const afterwards = new Date("2026-11-06T12:00:00Z");
    const r = reconcileOutbox(l1, [], afterwards);
    expect(r.ledger.items).toEqual({});
    expect(outboxPage(r.ledger, [], 0).items).toEqual([]);
  });

  it("drops tombstones after 30 days and treats a bad cursor as a fresh start", () => {
    const l1 = reconcileOutbox(outboxLedger(null), [rem("r1")], NOW).ledger;
    const l2 = reconcileOutbox(l1, [], NOW).ledger;
    expect(Object.values(l2.items)[0].deleted).toBe(true);
    const l3 = reconcileOutbox(l2, [], new Date(NOW.getTime() + 31 * 86_400_000)).ledger;
    expect(l3.items).toEqual({});
    expect(parseSince("abc", l3)).toBeNull();
    expect(parseSince("999", l3)).toBeNull();
    expect(parseSince("1", l3)).toBe(1);
  });
});
