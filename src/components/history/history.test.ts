import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/core";
import en from "@/lib/i18n/messages/en";
import da from "@/lib/i18n/messages/da";
import { historyLine, valueText, whoSaid } from "./pure";

const t = makeT("en", en);
const tDa = makeT("da", da, en);

describe("whoSaid", () => {
  it("groups people separately and every model run as the assistant", () => {
    const rows = whoSaid([
      { agentType: "user", agentId: "u1", quote: null, sourceId: null, sourceTitle: null, createdAt: "2026-01-01" },
      { agentType: "model", agentId: "mux:a", quote: "old", sourceId: "s1", sourceTitle: "Letter", createdAt: "2026-01-02" },
      { agentType: "model", agentId: "mux:b", quote: "new", sourceId: "s2", sourceTitle: "Mail", createdAt: "2026-02-02" },
      { agentType: "rule", agentId: "birthday", quote: null, sourceId: null, sourceTitle: null, createdAt: "2026-01-03" },
    ]);
    expect(rows.map((r) => r.key)).toEqual(["assistant", "rule", "user:u1"]);
    expect(rows[0]).toMatchObject({ count: 2, quote: "new", sourceTitle: "Mail" });
    expect(rows[2].userId).toBe("u1");
  });
  it("keeps an older quote when the newest record has none", () => {
    const [r] = whoSaid([
      { agentType: "user", agentId: "u1", quote: "said it", sourceId: null, sourceTitle: null, createdAt: "2026-01-01" },
      { agentType: "user", agentId: "u1", quote: null, sourceId: null, sourceTitle: null, createdAt: "2026-03-01" },
    ]);
    expect(r.quote).toBe("said it");
    expect(r.last.toISOString().slice(0, 10)).toBe("2026-03-01");
  });
});

describe("historyLine", () => {
  it("names the field and both values", () => {
    expect(historyLine({ kind: "updated", field: "label", fromValue: "Mormor", toValue: "Inge", actorKind: "person", actorName: "Anna" }, t))
      .toEqual({ head: "Anna changed the name", detail: "from Mormor to Inge" });
  });
  it("falls back to the actor kind and speaks Danish", () => {
    expect(historyLine({ kind: "created", field: null, fromValue: null, toValue: null, actorKind: "assistant", actorName: null }, tDa).head)
      .toBe("Assistenten tilføjede det");
    expect(historyLine({ kind: "updated", field: "aliases", fromValue: [], toValue: ["EAM"], actorKind: "person", actorName: "Lars" }, tDa))
      .toEqual({ head: "Lars ændrede de andre navne", detail: "fra ingenting til EAM" });
  });
  it("never shows raw keys for unknown kinds", () => {
    expect(historyLine({ kind: "rewound", field: null, fromValue: null, toValue: null, actorKind: "robot", actorName: null }, t).head).toBe("robot: rewound");
  });
  it("values read as words", () => {
    expect(valueText(true, t)).toBe("yes");
    expect(valueText(null, tDa)).toBe("ingenting");
    expect(valueText({ a: 1 }, t)).toBe("nothing");
  });
});
