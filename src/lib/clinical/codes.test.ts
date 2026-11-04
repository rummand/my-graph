import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCodes, lookupCode, stems, wordingMatches, type CodeTables } from "./codes";
import { parseCodeSuggestions } from "./pure";

const load = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), "assets", "codes", f), "utf8")) as { system: string; version: string; codes: CodeTables["ICD-10"] };
const icd = load("icd10.json");
const icpc = load("icpc2.json");
const tables: CodeTables = { "ICD-10": icd.codes, "ICPC-2": icpc.codes };

describe("the bundled code lists", () => {
  it("are the real lists, with English and Danish titles", () => {
    expect(icd.system).toBe("ICD-10");
    expect(Object.keys(icd.codes).length).toBeGreaterThan(10_000);
    expect(icd.codes["F32.1"]).toEqual(["Moderate depressive episode", "Depressiv enkeltepisode af moderat grad"]);
    expect(icd.codes["F43.1"]?.[0]).toBe("Post-traumatic stress disorder");
    expect(icpc.system).toBe("ICPC-2");
    expect(Object.keys(icpc.codes).length).toBeGreaterThan(600);
    expect(icpc.codes.P76).toEqual(["Depressive disorder", "Depression"]);
    expect(icpc.codes.T90?.[1]).toBe("Diabetes type 2");
  });

  it("finds a code or its parent", () => {
    expect(lookupCode(tables["ICPC-2"], "T90.02", "ICPC-2")?.code).toBe("T90");
    expect(lookupCode(tables["ICD-10"], "F32.1")?.en).toBe("Moderate depressive episode");
    expect(lookupCode(tables["ICD-10"], "F32.11")?.code).toBe("F32.1");
    expect(lookupCode(tables["ICD-10"], "F39.5")).toBeNull(); // made up: not quietly turned into F39
    expect(lookupCode(tables["ICD-10"], "F99.9")).toEqual({ code: "F99.9", en: null, da: "Psykisk lidelse eller forstyrrelse UNS" }); // SKS-D only
  });
});

describe("checking the assistant's code suggestions", () => {
  const text = "Hun har været nedtrykt i flere måneder og sover dårligt. Hun har sukkersyge.";

  it("drops codes that don't exist, shows the official title, flags odd wording", () => {
    const raw = { codes: [
      { system: "ICD-10", code: "F32.1", label: "Moderat depression", evidence: ["nedtrykt i flere måneder"], confidence: 0.7 },
      { system: "ICD-10", code: "F39.5", label: "Made up", evidence: ["sover dårligt"], confidence: 0.9 },
      { system: "ICPC-2", code: "P76", label: "Broken leg", evidence: ["nedtrykt i flere måneder"], confidence: 0.8 },
      { system: "ICPC-2", code: "T90", label: "Diabetes", evidence: ["sukkersyge"], confidence: 0.6 },
    ] };
    const out = checkCodes(parseCodeSuggestions(raw, text), tables, "da");
    expect(out.map((c) => c.code)).toEqual(["F32.1", "T90", "P76"]);
    const f32 = out.find((c) => c.code === "F32.1")!;
    expect(f32).toMatchObject({ officialTitle: "Depressiv enkeltepisode af moderat grad", label: "Depressiv enkeltepisode af moderat grad", suggestedAs: "Moderat depression", mismatch: false });
    const p76 = out.find((c) => c.code === "P76")!;
    expect(p76.mismatch).toBe(true);
    expect(p76.confidence).toBeLessThanOrEqual(0.3);
    expect(p76.officialTitle).toBe("Depression");
  });

  it("uses the session's language for the title", () => {
    const raw = [{ system: "ICPC-2", code: "P76", label: "Depression", evidence: ["nedtrykt"], confidence: 0.6 }];
    expect(checkCodes(parseCodeSuggestions(raw, text), tables, "en")[0].officialTitle).toBe("Depressive disorder");
  });

  it("compares wording by word stems, across Danish and English", () => {
    expect([...stems("Depressive episode, unspecified")]).toEqual(["depre", "episo"]);
    expect(wordingMatches("depression", ["Depressive disorder", null])).toBe(true);
    expect(wordingMatches("Type 2-diabetes", [null, "Diabetes type 2"])).toBe(true);
    expect(wordingMatches("Fractured femur", ["Depressive disorder", "Depression"])).toBe(false);
    expect(wordingMatches("", ["Anything"])).toBe(true);
  });
});
