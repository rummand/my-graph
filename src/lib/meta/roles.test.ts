import { describe, expect, it } from "vitest";
import { detectRole, detectRoles, roleKeyForKind, roleMention, roleRelation, roleKeyOf } from "./roles";
import { normalizeRelation } from "@/lib/gbrain/pure";

describe("role words (English and Danish)", () => {
  it("finds the most specific role", () => {
    expect(detectRole("Hun er klasselærer i 3.B")?.role).toBe("class_teacher");
    expect(detectRole("Our class teacher wrote")?.role).toBe("class_teacher");
    expect(detectRole("tandlægen ringede")?.role).toBe("dentist");
    expect(detectRole("Ring til lægen")?.role).toBe("doctor");
    expect(detectRole("The principal of Ny Skole")?.role).toBe("school_leader");
    expect(detectRole("pædagogen i vuggestuen")?.role).toBe("pedagogue");
    expect(detectRole("our landlord")?.role).toBe("landlord");
    expect(detectRole("Emma's football coach")?.role).toBe("coach");
    expect(detectRole("nothing here")).toBeNull();
  });
  it("lists every role once, a longer word never also counting as the shorter one", () => {
    expect(detectRoles("Lars er vores læge og nabo; tandlægen ringede").map((h) => h.role)).toEqual(["doctor", "neighbour", "dentist"]);
    expect(detectRoles("klasselæreren").map((h) => h.role)).toEqual(["class_teacher"]);
  });
  it("marks family words as family", () => {
    expect(detectRole("min svigermor")).toMatchObject({ role: "in_law", family: true });
    expect(detectRole("the teacher")?.family).toBe(false);
  });
});

describe("unnamed role mentions are not people", () => {
  const cases: [string, ReturnType<typeof roleMention>][] = [
    ["the teacher", { role: "teacher", contextHint: null }],
    ["Lægen", { role: "doctor", contextHint: null }],
    ["Udlejeren", { role: "landlord", contextHint: null }],
    ["vores nabo", { role: "neighbour", contextHint: null }],
    ["Speaker 2", { role: null, contextHint: null }],
    ["Taler 3", { role: null, contextHint: null }],
    ["Emma's teacher", { role: "teacher", contextHint: "Emma" }],
    ["Emmas lærer", { role: "teacher", contextHint: "Emma" }],
    ["klasselæreren i 3.B", { role: "class_teacher", contextHint: "3.B" }],
    ["the doctor at Lægehuset", { role: "doctor", contextHint: "Lægehuset" }],
    ["Our grandmother", { role: "grandparent", contextHint: null }],
  ];
  for (const [label, want] of cases) it(`"${label}"`, () => expect(roleMention(label)).toEqual(want));
  it("a name next to the role is a person", () => {
    for (const l of ["Dr. Mette Lund", "Karen Hansen", "Ms. Karen Hansen", "Lærer Karen", "Person 12"]) expect(roleMention(l)).toBeNull();
  });
  it("a bare family word is how a family names one person", () => {
    expect(roleMention("Mormor")).toBeNull();
    expect(roleMention("Dad")).toBeNull();
  });
});

describe("roles as relations", () => {
  it("round-trips the role relation and survives relation normalising", () => {
    expect(roleRelation("class_teacher")).toBe("role:class_teacher");
    expect(roleKeyOf("role:doctor")).toBe("doctor");
    expect(roleKeyOf("parent_of")).toBeNull();
    expect(normalizeRelation("role:Class Teacher")).toBe("role:class_teacher");
    expect(normalizeRelation("Parent Of")).toBe("parent_of");
  });
  it("turns role kinds into roles, keeps who-someone-is kinds and clinical records", () => {
    const keys = new Set(["doctor", "teacher", "child", "partner", "client"]);
    expect(roleKeyForKind("doctor", keys)).toBe("doctor");
    expect(roleKeyForKind("child", keys)).toBeNull();
    expect(roleKeyForKind("partner", keys)).toBeNull();
    expect(roleKeyForKind("client", keys)).toBeNull();
    expect(roleKeyForKind("department", keys)).toBeNull();
  });
});
