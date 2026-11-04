import { describe, expect, it } from "vitest";
import { buildThreadItems, cleanSubject, documentItem, personMatcher, type DatedSource } from "./documents";

const mail = (id: string, at: string, e: Record<string, unknown>, threadKey: string | null): DatedSource => ({
  id, title: String(e.subject ?? id), mime: "message/rfc822", kind: "email", documentDate: new Date(at), documentDatePrecision: "minute",
  threadKey, nodeId: `n-${id}`, sensitive: false, meta: { email: e },
});
const match = personMatcher([
  { id: "p-anna", label: "Anna Hansen", aliases: [], emails: ["anna@x.dk"] },
  { id: "p-bo", label: "Bo Hansen", aliases: ["Bo"], emails: [] },
]);

describe("buildThreadItems", () => {
  it("joins messages from separate uploads into one conversation on the participants' lanes", () => {
    const a = mail("a", "2026-10-01T08:00:00Z", { messageId: "a@x", references: [], subject: "Tur", participants: [{ name: "Anna", email: "anna@x.dk", role: "from" }, { name: "Bo Hansen", email: "bo@skole.dk", role: "to" }] }, "mid:a@x");
    const b = mail("b", "2026-10-02T09:00:00Z", { messageId: "b@x", inReplyTo: "a@x", references: [], subject: "SV: Tur", participants: [{ name: "Bo Hansen", email: "bo@skole.dk", role: "from" }] }, "mid:a@x");
    const c = mail("c", "2026-10-03T10:00:00Z", { messageId: "c@x", inReplyTo: "b@x", references: [], subject: "Re: Tur", participants: [{ name: null, email: "anna@x.dk", role: "from" }] }, "mid:b@x");
    const z = mail("z", "2026-09-01T10:00:00Z", { messageId: "z@x", references: [], subject: "Other", participants: [{ name: "Ukendt", email: "u@x.dk", role: "from" }] }, "mid:z@x");
    const items = buildThreadItems([c, z, a, b], { personFor: match, laneSet: new Set(["p-anna", "p-bo"]) });
    expect(items).toHaveLength(2);
    const t = items.find((i) => i.thread!.messages.length === 3)!;
    expect(t.title).toBe("Tur");
    expect(t.thread!.messages.map((m) => m.sourceId)).toEqual(["a", "b", "c"]);
    expect(t.start).toBe("2026-10-01T08:00:00.000Z");
    expect(t.end).toBe("2026-10-03T10:00:00.000Z");
    expect(t.laneIds.sort()).toEqual(["p-anna", "p-bo"]);
    const other = items.find((i) => i !== t)!;
    expect(other.laneIds).toEqual(["family"]);
    expect(other.end).toBeNull();
  });
});

describe("documents", () => {
  it("places a document at its own date on the lanes of the people it names", () => {
    const d = documentItem({ id: "d", title: "Brev", mime: "application/pdf", kind: "upload", documentDate: new Date("2024-03-03T12:00:00Z"), documentDatePrecision: "day", threadKey: null, nodeId: "n", sensitive: false, meta: { docKind: "scan" } }, ["p-bo"], new Set(["p-bo"]));
    expect(d).toMatchObject({ kind: "document", start: "2024-03-03T12:00:00.000Z", precision: "day", laneIds: ["p-bo"], docKind: "scan", sourceId: "d" });
  });
  it("matches people by email, then by a unique name", () => {
    expect(match({ name: null, email: "ANNA@x.dk" })).toBe("p-anna");
    expect(match({ name: "Bo", email: "bo@skole.dk" })).toBe("p-bo");
    expect(match({ name: "Karl", email: "k@x.dk" })).toBeNull();
  });
  it("cleans reply prefixes from a subject", () => {
    expect(cleanSubject("SV: Re: Tur")).toBe("Tur");
  });
});
