import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookup, makeT, type MessageTree } from "@/lib/i18n/core";
import en from "@/lib/i18n/messages/en/pages";
import da from "@/lib/i18n/messages/da/pages";
import { cowriteExamples, cowriteWarning, visibilityBadge, visibilityHint, visibilityLabel, visibilitySentence } from "./copy";
import { calendarDaysAgo, makeWhen } from "./when";

const dict = { en: { pages: en }, da: { pages: da } };
const tEn = makeT("en", dict.en);
const tDa = makeT("da", dict.da, dict.en);

function leaves(tree: MessageTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") return [key];
    if (v && typeof v === "object" && typeof (v as { one?: unknown }).one === "string") return [key];
    return leaves(v as MessageTree, key);
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
  });
}

describe("pages messages", () => {
  it("Danish has every English key, and nothing extra", () => {
    expect(leaves(da).sort()).toEqual(leaves(en).sort());
  });

  it("every literal pages.* key used in the pages UI exists in English", () => {
    const root = process.cwd();
    const files = [...filesUnder(join(root, "src/components/pages")), ...filesUnder(join(root, "src/app/(app)/artifacts/pages"))];
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/["`]pages\.([a-zA-Z0-9.]+)["`]/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used].filter((k) => !k.endsWith(".") && lookup(en, k) === undefined);
    expect(missing).toEqual([]);
  });
});

describe("graph-kind wording", () => {
  it("says parents and whole family only in a family graph", () => {
    expect(visibilityLabel(tEn, "household", true)).toBe("Whole family");
    expect(visibilityLabel(tEn, "household", false)).toBe("Everyone in this graph");
    expect(visibilityLabel(tEn, "parents", false)).toBe("Owner and editors");
    for (const v of ["private", "parents", "household"] as const) {
      for (const s of [visibilityLabel(tEn, v, false), visibilityHint(tEn, v, false), visibilitySentence(tEn, v, false), visibilityBadge(tEn, v, false) ?? ""]) {
        expect(s).not.toMatch(/famil|parent|child/i);
      }
    }
    expect(visibilityBadge(tEn, "household", false)).toBeNull();
    expect(visibilityLabel(tDa, "household", true)).toBe("Hele familien");
    expect(visibilityLabel(tDa, "household", false)).toBe("Alle i denne graf");
  });

  it("uses family co-writing examples only in a family graph, falling back per example", () => {
    expect(cowriteExamples(tEn, "insert", true)[0]).toMatch(/summer house/);
    expect(cowriteExamples(tEn, "insert", false).join(" ")).not.toMatch(/school|summer/i);
    expect(cowriteExamples(tEn, "rewrite", true)).toEqual(cowriteExamples(tEn, "rewrite", false));
    expect(cowriteExamples(tDa, "page", true)[1]).toBe("Ryd op på siden og tilføj overskrifter");
  });

  it("warns about narrower sources in the graph's own words", () => {
    const src = [{ visibility: "private" as const }, { visibility: "parents" as const }];
    expect(cowriteWarning(tEn, [{ visibility: "household" }], "household", { family: false })).toBeNull();
    expect(cowriteWarning(tEn, src, "household", { family: true })).toBe(
      "This draft used 2 items (1 only you can see, 1 only parents can see). If you keep it, everyone in the family, children included, will see what it says here.");
    const generic = cowriteWarning(tEn, src, "household", { family: false, cited: false }) ?? "";
    expect(generic).toMatch(/everyone in this graph will see/);
    expect(generic).not.toMatch(/famil|parent|child/i);
    expect(cowriteWarning(tDa, [{ visibility: "private" }], "parents", { family: false })).toBe(
      "Dette udkast brugte et element (1 som kun du kan se). Hvis du beholder det, kan grafens ejer og redaktører se, hvad der står her.");
  });
});

describe("when", () => {
  const now = new Date("2026-11-04T13:00:00Z"); // Wednesday, 14:00 in Copenhagen
  const en = makeWhen({ t: tEn, locale: "en", timeZone: "Europe/Copenhagen", now: () => now });
  const daW = makeWhen({ t: tDa, locale: "da", timeZone: "Europe/Copenhagen", now: () => now });

  it("counts calendar days in the reader's zone", () => {
    expect(calendarDaysAgo(new Date("2026-11-03T23:30:00Z"), now, "Europe/Copenhagen")).toBe(0); // 00:30 local, same day
    expect(calendarDaysAgo(new Date("2026-11-03T23:30:00Z"), now, "UTC")).toBe(1);
  });

  it("speaks English and Danish", () => {
    const today = new Date("2026-11-04T08:05:00Z");
    expect(en.sentence(today)).toBe("today at 09:05");
    expect(daW.sentence(today)).toBe("i dag kl. 09.05");
    expect(en.short(new Date("2026-11-03T10:00:00Z"))).toBe("Yesterday");
    expect(daW.short(new Date("2026-11-03T10:00:00Z"))).toBe("I går");
    expect(en.sentence(new Date("2026-11-01T10:00:00Z"))).toBe("on Sunday at 11:00");
    expect(daW.sentence(new Date("2026-11-01T10:00:00Z"))).toBe("søndag kl. 11.00");
    expect(en.sentence(new Date("2025-03-01T10:00:00Z"))).toBe("on 1 Mar 2025");
  });

  it("groups by recency", () => {
    expect(en.group(new Date("2026-11-04T00:10:00Z"))).toBe("today");
    expect(en.group(new Date("2026-10-30T10:00:00Z"))).toBe("week");
    expect(en.group(new Date("2026-10-10T10:00:00Z"))).toBe("month");
    expect(en.group(new Date("2026-02-10T10:00:00Z"))).toBe("year");
    expect(en.group(new Date("2025-12-10T10:00:00Z"))).toBe("older");
    expect(daW.groupLabel("year")).toBe("Tidligere i år");
  });
});
