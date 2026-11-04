import { describe, expect, it } from "vitest";
import { chunkOfQuote, coverage, dedupeRules, defaultSeverity, diffVersion, normalizeRef, parseExtraction, passagesOf, readModality, sectionOf } from "./pure";

const LAW = [
  "§ 16. Netvirksomheden skal sikre, at informationsudveksling sker gennem datahubben.",
  "Stk. 2. Enhver informationsstrøm skal angive, hvem der ejer dataene.",
  "Stk. 3. Netvirksomheden må ikke videregive måledata til tredjepart uden kundens samtykke.",
  "§ 17. Netvirksomheden bør dokumentere sine dataflows årligt.",
].join("\n");

describe("rule extraction parsing", () => {
  it("keeps rules whose quote is really in the passage, with its exact words and place", () => {
    const raw = { rules: [
      { ref: "§16 stk. 2", title: "Name the data owner", text: "Every information flow must say who owns the data.", modality: "must",
        quote: "Enhver informationsstrøm skal angive, hvem der ejer dataene.", check_hint: "Each flow names an owner.", severity: "blocker" },
      { ref: "§16 stk. 3", text: "Don't pass metering data to third parties without consent.", modality: "må ikke",
        quote: "netvirksomheden  må ikke videregive måledata til tredjepart uden kundens samtykke" },
    ] };
    const { rules, dropped } = parseExtraction(raw, LAW, { binding: "mandatory" });
    expect(dropped).toEqual([]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ ref: "§16 stk. 2", modality: "must", severity: "blocker", checkHint: "Each flow names an owner." });
    expect(LAW.slice(rules[0].quoteStart, rules[0].quoteEnd)).toBe(rules[0].quote);
    // Case and spacing differences are forgiven; the stored quote is the passage's own text.
    expect(rules[1].modality).toBe("must_not");
    expect(rules[1].quote).toBe("Netvirksomheden må ikke videregive måledata til tredjepart uden kundens samtykke");
    expect(rules[1].severity).toBe("major");
    expect(rules[1].title).toBe("Don't pass metering data to third parties without consent.");
  });

  it("drops invented quotes, missing modalities and incomplete items", () => {
    const raw = { rules: [
      { ref: "§99", text: "Something the law never says at all.", modality: "must", quote: "Dette står ikke i teksten overhovedet." },
      { ref: "§17", text: "Document data flows every year.", modality: "perhaps", quote: "Netvirksomheden bør dokumentere sine dataflows årligt." },
      { ref: "§16", modality: "must" },
    ] };
    const { rules, dropped } = parseExtraction(raw, LAW, { binding: "mandatory" });
    expect(rules).toEqual([]);
    expect(dropped.map((d) => d.why)).toEqual(["quote not in the text", "no modality", "incomplete"]);
  });

  it("accepts a bare array and caps severity for advisory corpora", () => {
    const { rules } = parseExtraction([{ ref: "§17", text: "Document data flows every year.", modality: "should", quote: "bør dokumentere sine dataflows årligt", severity: "blocker" }], LAW, { binding: "advisory" });
    expect(rules[0].severity).toBe("major");
    expect(() => parseExtraction({ nope: 1 }, LAW, { binding: "mandatory" })).toThrow();
  });

  it("reads Danish and English modality words", () => {
    expect(readModality("skal")).toBe("must");
    expect(readModality("Must not")).toBe("must_not");
    expect(readModality("bør")).toBe("should");
    expect(readModality("may")).toBe("may");
    expect(readModality("whatever")).toBeNull();
    expect(defaultSeverity("should", "mandatory")).toBe("minor");
    expect(defaultSeverity("must", "advisory")).toBe("minor");
  });
});

describe("references and sections", () => {
  it("groups references by section", () => {
    expect(sectionOf("§16 stk. 2")).toBe("§ 16");
    expect(sectionOf("§ 7, nr. 3")).toBe("§ 7");
    expect(sectionOf("§ 16 a, stk. 1")).toBe("§ 16 a");
    expect(sectionOf("ADR-4.2")).toBe("ADR-4");
    expect(sectionOf("adr 4.2.1")).toBe("ADR-4");
    expect(sectionOf("Kapitel 3")).toBe("Kapitel 3");
    expect(sectionOf("Konvention 3")).toBe("Konvention 3");
  });
  it("folds equivalent references", () => {
    expect(normalizeRef("§ 16, Stk. 2")).toBe(normalizeRef("§16 stk 2"));
  });
});

describe("dedupe", () => {
  const a = { ref: "§16 stk. 2", text: "Every information flow must name who owns the data.", quote: "Enhver informationsstrøm skal angive, hvem der ejer dataene.", modality: "must" };
  it("drops the same rule read twice (same reference, close wording)", () => {
    const b = { ref: "§ 16, stk. 2", text: "Each information flow must name the owner of the data.", quote: "Enhver informationsstrøm skal angive, hvem der ejer dataene", modality: "must" };
    const { kept, duplicates } = dedupeRules([a, b]);
    expect(kept).toEqual([a]);
    expect(duplicates).toEqual([b]);
  });
  it("drops a guide quoting the law's exact words under another reference", () => {
    const guide = { ref: "Vejledning 4.1", text: "Information flows need a named data owner.", quote: "Enhver informationsstrøm skal angive, hvem der ejer dataene.", modality: "must" };
    expect(dedupeRules([guide], [a]).kept).toEqual([]);
  });
  it("keeps different rules, even under the same section", () => {
    const c = { ref: "§16 stk. 3", text: "Metering data may not go to third parties without consent.", quote: "må ikke videregive måledata til tredjepart", modality: "must_not" };
    expect(dedupeRules([a, c]).kept).toHaveLength(2);
  });
});

describe("a new version", () => {
  const current = [
    { id: "r1", ref: "§16 stk. 2", text: "Every information flow must name who owns the data.", quote: "Enhver informationsstrøm skal angive, hvem der ejer dataene.", modality: "must" },
    { id: "r2", ref: "§16 stk. 3", text: "Metering data may not go to third parties without consent.", quote: "må ikke videregive måledata", modality: "must_not" },
    { id: "r3", ref: "§17", text: "Document data flows every year.", quote: "bør dokumentere sine dataflows årligt", modality: "should" },
  ];
  it("proposes what was added, changed and removed", () => {
    const next = [
      { ref: "§16 stk. 2", text: "Every information flow must name who owns the data.", quote: "Enhver informationsstrøm skal angive, hvem der ejer dataene.", modality: "must" },
      { ref: "§ 17", text: "Document data flows every quarter and publish the overview.", quote: "skal dokumentere sine dataflows hvert kvartal", modality: "must" },
      { ref: "§18", text: "Report breaches within 72 hours.", quote: "inden for 72 timer", modality: "must" },
    ];
    const d = diffVersion(current, next);
    expect(d.unchanged.map((x) => x.from.id)).toEqual(["r1"]);
    expect(d.changed.map((x) => [x.from.id, x.to.ref])).toEqual([["r3", "§ 17"]]);
    expect(d.added.map((x) => x.ref)).toEqual(["§18"]);
    expect(d.removed.map((x) => x.id)).toEqual(["r2"]);
  });
});

describe("passages", () => {
  it("groups chunks and maps a quote back to its chunk and characters", () => {
    const chunks = [
      { id: "c1", text: "a".repeat(30), locator: { page: 1, charStart: 0, charEnd: 30 } },
      { id: "c2", text: "Stk. 2. Enhver informationsstrøm skal angive ejeren.", locator: { page: 2, charStart: 30, charEnd: 82 } },
    ];
    const [p, ...rest] = passagesOf(chunks, 6000);
    expect(rest).toEqual([]);
    const start = p.text.indexOf("Enhver");
    const at = chunkOfQuote(p, start, start + 10);
    expect(at).toEqual({ chunkId: "c2", locator: { page: 2, charStart: 38, charEnd: 48 } });
    expect(passagesOf(chunks, 40)).toHaveLength(2);
  });
  it("counts coverage", () => {
    expect(coverage([{ status: "active" }, { status: "proposed" }, { status: "active" }, { status: "retired" }])).toEqual({ active: 2, proposed: 1, retired: 1 });
  });
});

describe("rule scope from the model", () => {
  it("keeps where a rule applies, never the model's topic words", async () => {
    const { structuralScope } = await import("./pure");
    expect(structuralScope({ tags: ["measurement_data"] })).toEqual({});
    expect(structuralScope({ tags: ["x"], targetTypes: ["wiki"], wikiSlugs: [] })).toEqual({ targetTypes: ["wiki"] });
    const { rules } = parseExtraction({ rules: [{ ref: "§3", text: "Encrypt personal data in transfer.", modality: "must", quote: "skal krypteres", applies_to: { tags: ["personal_data"] } }] }, "Oplysninger skal krypteres under overførsel.", { binding: "mandatory" });
    expect(rules[0].appliesTo).toEqual({});
  });
});
