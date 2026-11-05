import { describe, expect, it } from "vitest";
import { detectDetails, maybeNewNames } from "./detect";

const kinds = (text: string) => detectDetails(text).map((d) => `${d.kind}:${d.text}`);

describe("deterministic detectors", () => {
  it("finds English dates and times", () => {
    expect(kinds("Swimming next Friday at 16:30, then dinner tomorrow at 7pm.")).toEqual(["date:next Friday", "time:16:30", "date:tomorrow", "time:7pm"]);
    expect(kinds("On 12 March 2026 and March 14th")).toEqual(["date:12 March 2026", "date:March 14th"]);
    expect(kinds("due 2026-03-12 or 12/3")).toEqual(["date:2026-03-12", "date:12/3"]);
  });
  it("finds Danish dates and times", () => {
    expect(kinds("Vi ses på torsdag kl. 14 og i morgen")).toEqual(["date:på torsdag", "time:kl. 14", "date:i morgen"]);
    expect(kinds("Tiden er flyttet til den 12. marts kl 9.30")).toEqual(["date:den 12. marts", "time:kl 9.30"]);
    expect(kinds("i næste uge eller i weekenden")).toEqual(["date:i næste uge", "date:i weekenden"]);
  });
  it("finds emails, links, phones and money", () => {
    expect(kinds("Mail karen.holm@example.com or see https://aula.dk/x.")).toEqual(["email:karen.holm@example.com", "url:https://aula.dk/x"]);
    expect(kinds("Ring på 22 33 44 55 eller +45 22334455")).toEqual(["phone:22 33 44 55", "phone:+45 22334455"]);
    expect(kinds("Det koster 450 kr. eller 1.200,50 kr, $20 og DKK 300")).toEqual(["money:450 kr", "money:1.200,50 kr", "money:$20", "money:DKK 300"]);
  });
  it("doesn't take an ISO date for a phone number", () => {
    expect(kinds("2026-03-12")).toEqual(["date:2026-03-12"]);
  });
});

describe("maybe-new names", () => {
  const names = (text: string, taken: { start: number; end: number }[] = []) => maybeNewNames(text, taken).map((d) => d.text);
  it("finds runs of capitalised words, not sentence starts or common words", () => {
    expect(names("Mikkel's new colleague Peter Andersen from Novo Nordisk joins us.")).toEqual(["Peter Andersen", "Novo Nordisk"]);
    expect(names("The kids went home. Then I called Lars Petersen fra Rema 1000.")).toEqual(["Lars Petersen", "Rema 1000"]);
  });
  it("keeps a single capitalised word mid-sentence, not at the start", () => {
    expect(names("Emma met Gertrud today")).toEqual(["Gertrud"]);
    expect(names("Gertrud met us")).toEqual([]);
  });
  it("skips days, months and pronouns", () => {
    expect(names("we meet on Friday in March, and I will")).toEqual([]);
  });
  it("keeps titles with the name", () => {
    expect(names("Noahs tandlæge Dr. Mette Lund ringede")).toEqual(["Dr. Mette Lund"]);
  });
  it("skips what is already taken", () => {
    const text = "Emma met Peter Andersen";
    expect(names(text, [{ start: 9, end: 23 }])).toEqual([]);
  });
});
