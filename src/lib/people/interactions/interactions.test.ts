import { describe, expect, it } from "vitest";
import { bandOf, closenessOf, decayed, linesOf, matchRef, pickNudge, readableRows, scoreOf, THRESHOLDS } from "./pure";

const now = new Date("2026-11-05T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe("decay", () => {
  it("halves a strong interaction every 90 days", () => {
    expect(decayed({ kind: "email", at: ago(0) }, now)).toBeCloseTo(3);
    expect(decayed({ kind: "email", at: ago(90) }, now)).toBeCloseTo(1.5);
    expect(decayed({ kind: "call", at: ago(180) }, now)).toBeCloseTo(0.75);
  });
  it("weak mentions fade faster than meetings", () => {
    expect(decayed({ kind: "mention", at: ago(30) }, now)).toBeCloseTo(0.25);
    expect(decayed({ kind: "meeting", at: ago(60) }, now)).toBeCloseTo(1);
  });
  it("sums and ignores the far future", () => {
    expect(scoreOf([{ kind: "email", at: ago(0) }, { kind: "photo", at: ago(0) }, { kind: "email", at: "2030-01-01" }], now)).toBeCloseTo(5);
  });
});

describe("bands", () => {
  it("uses the thresholds", () => {
    expect(bandOf(THRESHOLDS.close)).toBe("close");
    expect(bandOf(1)).toBe("in_touch");
    expect(bandOf(0.2)).toBe("drifting");
    expect(bandOf(0.01)).toBe("faded");
  });
  it("an email this week is close; one a year ago is drifting; fifteen months is faded", () => {
    expect(closenessOf({ rows: [{ nodeId: "a", kind: "email", at: ago(3) }], createdAt: ago(800) }, now).band).toBe("close");
    expect(closenessOf({ rows: [{ nodeId: "a", kind: "email", at: ago(365) }], createdAt: ago(800) }, now).band).toBe("drifting");
    expect(closenessOf({ rows: [{ nodeId: "a", kind: "email", at: ago(460) }], createdAt: ago(800) }, now).band).toBe("faded");
  });
  it("people with no interactions: new ones stay in touch, old ones fade", () => {
    expect(closenessOf({ rows: [], createdAt: ago(10) }, now).band).toBe("in_touch");
    expect(closenessOf({ rows: [], createdAt: ago(200) }, now).band).toBe("drifting");
    const old = closenessOf({ rows: [], createdAt: ago(500) }, now);
    expect(old.band).toBe("faded");
    expect(old.unseen).toBe(true);
  });
});

describe("floors", () => {
  const quiet = { rows: [{ nodeId: "a", kind: "email", at: ago(900) }], createdAt: ago(1000) };
  it("pinned people, members and close family never fade below drifting but keep their last contact", () => {
    for (const extra of [{ pinned: true }, { member: true }, { family: true }]) {
      const c = closenessOf({ ...quiet, ...extra }, now);
      expect(c.band).toBe("drifting");
      expect(c.floor).toBe(true);
      expect(c.lastInTouch?.at).toBe(ago(900));
    }
    expect(closenessOf(quiet, now).band).toBe("faded");
  });
  it("the viewer is always close", () => {
    expect(closenessOf({ rows: [], createdAt: ago(1000), isViewer: true }, now).band).toBe("close");
  });
});

describe("per-viewer filtering", () => {
  const rows = [
    { nodeId: "p", kind: "email", at: ago(1), sourceId: "s-mine" },
    { nodeId: "p", kind: "message", at: ago(1), sourceId: "s-anna-private" },
    { nodeId: "p", kind: "event", at: ago(1), subjectId: "e-shared" },
    { nodeId: "p", kind: "event", at: ago(1), subjectId: "e-hidden" },
    { nodeId: "p", kind: "edit", at: ago(1) },
  ];
  it("keeps only what the viewer may read", () => {
    const kept = readableRows(rows, { source: (id) => id === "s-mine", node: (id) => id === "e-shared", row: () => true });
    expect(kept.map((r) => r.sourceId ?? r.subjectId ?? r.kind)).toEqual(["s-mine", "e-shared", "edit"]);
  });
  it("another member's private interactions don't move the viewer's closeness", () => {
    const mine = closenessOf({ rows: readableRows(rows, { source: (id) => id === "s-mine", node: () => false }), createdAt: ago(10) }, now);
    const all = closenessOf({ rows, createdAt: ago(10) }, now);
    expect(mine.score).toBeLessThan(all.score);
  });
});

describe("nudge", () => {
  it("only someone who used to be close and is now drifting or faded", () => {
    const wasClose = closenessOf({ rows: [0, 3, 6, 10].map((d) => ({ nodeId: "a", kind: "message", at: ago(400 + d) })), createdAt: ago(900) }, now);
    expect(wasClose.usedToBeClose).toBe(true);
    const acquaintance = closenessOf({ rows: [{ nodeId: "b", kind: "mention", at: ago(400) }], createdAt: ago(900) }, now);
    expect(acquaintance.usedToBeClose).toBe(false);
    const stillClose = closenessOf({ rows: [{ nodeId: "c", kind: "message", at: ago(150) }, { nodeId: "c", kind: "message", at: ago(2) }], createdAt: ago(900) }, now);
    expect(stillClose.usedToBeClose).toBe(false);
    expect(pickNudge([{ id: "a", closeness: wasClose }, { id: "b", closeness: acquaintance }])?.id).toBe("a");
    expect(pickNudge([{ id: "b", closeness: acquaintance }])).toBeNull();
  });
});

describe("reading importer text", () => {
  it("finds chat authors per day", () => {
    const hits = linesOf("WhatsApp · Mor · 2024-03-12\n09:12 Mor: Hej skat\n09:13 Anna: Hej\n10:00 — Mor changed the subject", "chat");
    expect(hits).toEqual([{ day: "2024-03-12", time: "09:12", name: "Mor", phone: null }, { day: "2024-03-12", time: "09:13", name: "Anna", phone: null }]);
  });
  it("finds who a call was with", () => {
    const hits = linesOf("Calls on 2026-11-05\n08:00 Incoming phone call from Ida Sample Hansen (+45 20 11 22 33), 4 min", "calls");
    expect(hits[0]).toMatchObject({ day: "2026-11-05", name: "Ida Sample Hansen", phone: "+45 20 11 22 33" });
  });
  it("matches by email, phone, full name or a unique first name", () => {
    const people = [
      { id: "1", label: "Ida Sample Hansen", aliases: [], emails: ["ida@x.dk"], phones: ["20112233"] },
      { id: "2", label: "Lars Holm", aliases: ["Lasse"], emails: [], phones: [] },
      { id: "3", label: "Lars Berg", aliases: [], emails: [], phones: [] },
    ];
    expect(matchRef(people, { email: "IDA@x.dk" })?.id).toBe("1");
    expect(matchRef(people, { phone: "+45 20 11 22 33" })?.id).toBe("1");
    expect(matchRef(people, { name: "Lasse" })?.id).toBe("2");
    expect(matchRef(people, { name: "Ida" })?.id).toBe("1");
    expect(matchRef(people, { name: "Lars" })).toBeNull();
  });
});
