import { describe, expect, it } from "vitest";
import { makeT, lookup, type MessageTree } from "@/lib/i18n/core";
import en from "@/lib/i18n/messages/en";
import da from "@/lib/i18n/messages/da";
import { upcomingSummary } from "./layout";
import { capitalize, datePrefixKey, makeWhen } from "./when";
import { KIND_LABEL, MARK_LABEL, STATUS_LABEL } from "./labels";

const enW = makeWhen("en"), daW = makeWhen("da");
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe("timeline dates", () => {
  it("formats a day in each language", () => {
    expect(enW.when(local(2026, 3, 3, 12), null, "day")).toBe("3 March 2026");
    expect(daW.when(local(2026, 3, 3, 12), null, "day")).toBe("3. marts 2026");
  });
  it("keeps month and year precision", () => {
    expect(daW.when(local(2026, 3, 15), null, "month")).toBe("marts 2026");
    expect(enW.when(local(2026, 3, 15), null, "year")).toBe("2026");
  });
  it("collapses ranges in the same month", () => {
    expect(enW.when(local(2026, 3, 3, 12), local(2026, 3, 5, 12), "day")).toBe("3 – 5 March 2026");
    expect(daW.when(local(2026, 3, 3, 12), local(2026, 3, 5, 12), "day")).toBe("3. – 5. marts 2026");
  });
  it("writes times the Danish way", () => {
    expect(daW.when(local(2026, 3, 3, 14, 30), null, "minute")).toBe("3. marts 2026 kl. 14:30");
    expect(enW.when(local(2026, 3, 3, 14, 30), null, "minute")).toBe("3 March 2026, 14:30");
  });
  it("capitalises Danish headings", () => {
    expect(daW.monthHeading(local(2026, 3, 1))).toBe("Marts 2026");
    expect(daW.upper(local(2026, 3, 1), "day")).toBe("Marts 2026");
    expect(capitalize("")).toBe("");
  });
  it("names the window on screen", () => {
    expect(enW.range(local(2026, 11, 3).getTime(), local(2026, 12, 1).getTime())).toBe("3 Nov – 1 Dec");
  });
  it("puts a word before reminders, uploads and documents only", () => {
    expect(datePrefixKey("reminder")).toBe("timeline.when.due");
    expect(datePrefixKey("event")).toBeNull();
  });
});

describe("summary in Danish", () => {
  it("reads naturally", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const t = makeT("da", da, en);
    const s = upcomingSummary([{ kind: "event", title: "Udflugt", start: new Date(Date.UTC(2026, 10, 26, 8)).toISOString() }], now, { t, when: daW });
    expect(s).toBe("Én ting de næste 30 dage. Næste: Udflugt, tor. 26. nov.");
  });
});

/** Every leaf key of a message tree (plural sets count as one leaf). */
function leaves(tree: MessageTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") return [key];
    if (typeof v === "object" && "other" in v && typeof v.other === "string") return [key];
    return leaves(v as MessageTree, key);
  });
}

describe("timeline messages", () => {
  it("has Danish for every English key and nothing extra", () => {
    expect(leaves(da.timeline).sort()).toEqual(leaves(en.timeline).sort());
  });
  it("has text for every label key the components use", () => {
    for (const key of [...Object.values(STATUS_LABEL), ...Object.values(KIND_LABEL), ...Object.values(MARK_LABEL)]) {
      expect(lookup(en, key), key).toBeTypeOf("string");
      expect(lookup(da, key), key).toBeTypeOf("string");
    }
  });
});
