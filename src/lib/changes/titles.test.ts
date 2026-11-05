import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/core";
import { DICTIONARIES } from "@/lib/i18n/messages";
import { localizeTitle, recognizeTitle, titleKeyFor } from "./titles";
import { localizeSourceTitle, sourceTitleKey } from "@/lib/ingest/titles";

const da = makeT("da", DICTIONARIES.da, DICTIONARIES.en);
const en = makeT("en", DICTIONARIES.en);

describe("proposal titles in the reader's language", () => {
  it("recognises My Graph's own English titles and keeps the values", () => {
    expect(recognizeTitle("From “Skolebrev.pdf”")).toEqual({ key: "stored.titles.fromSource", params: { title: "Skolebrev.pdf" } });
    expect(recognizeTitle("From the meeting “Forældremøde”")).toEqual({ key: "stored.titles.fromMeeting", params: { title: "Forældremøde" } });
    expect(recognizeTitle("Remove 3 dates that came from Familiekalender")).toEqual({ key: "stored.titles.removeDates", params: { count: 3, label: "Familiekalender" } });
    expect(recognizeTitle("1 date from the Aula calendar")?.key).toBe("stored.titles.aulaCalendarDates");
    expect(recognizeTitle("2 dates from RSS")).toEqual({ key: "stored.titles.datesFrom", params: { count: 2, label: "RSS" } });
    expect(recognizeTitle("2 people, 1 school or daycare from Aula")).toEqual({ key: "stored.titles.aulaPeople", params: { people: 2, places: 1, connections: 0 } });
    expect(recognizeTitle("2 new dates, 1 cancellation from Fodbold")).toEqual({ key: "stored.titles.calendarUpdates", params: { add: 2, update: 0, cancel: 1, label: "Fodbold" } });
    expect(recognizeTitle("Summer plans for Ida")).toBeNull();
  });

  it("shows a Danish reader Danish, an English reader the English", () => {
    const row = { title: "From “Skolebrev.pdf”", ...titleKeyFor("From “Skolebrev.pdf”") };
    expect(row.titleKey).toBe("stored.titles.fromSource");
    expect(localizeTitle(row, da)).toBe("Fra „Skolebrev.pdf“");
    expect(localizeTitle(row, en)).toBe("From “Skolebrev.pdf”");
    expect(localizeTitle({ title: "Remove 1 date that came from Familie" }, da)).toBe("Fjern 1 dato, der kom fra Familie");
    expect(localizeTitle({ title: "2 people, 1 school or daycare, 3 connections from Aula" }, da)).toBe("2 personer, 1 skole eller daginstitution, 3 forbindelser fra Aula");
    expect(localizeTitle({ title: "People from Aula" }, da)).toBe("Personer fra Aula");
    expect(localizeTitle({ title: "1 new date, 2 changes from Fodbold" }, da)).toBe("1 ny dato, 2 ændringer fra Fodbold");
    expect(localizeTitle({ title: "Calendar updates from Fodbold" }, da)).toBe("Kalenderopdateringer fra Fodbold");
    expect(localizeTitle({ title: "Changes in the Aula calendar" }, da)).toBe("Ændringer i Aula-kalenderen");
  });

  it("a rest-of set reads in the reader's language all the way down", () => {
    expect(localizeTitle({ title: "Rest of From “Brev”", titleKey: "stored.titles.restOf", titleParams: { title: "From “Brev”" } }, da)).toBe("Resten af Fra „Brev“");
    expect(localizeTitle({ title: "Rest of Summer plans", titleKey: "stored.titles.restOf", titleParams: { title: "Summer plans" } }, da)).toBe("Resten af Summer plans");
  });

  it("a title someone wrote, or a key this build doesn't know, is shown as written", () => {
    expect(localizeTitle({ title: "Ida's birthday" }, da)).toBe("Ida's birthday");
    expect(localizeTitle({ title: "X", titleKey: "stored.titles.fromTheFuture", titleParams: {} }, da)).toBe("X");
    expect(localizeTitle({ title: "X", titleKey: "changes.title", titleParams: {} }, da)).toBe("X"); // only stored.titles.* keys
  });

  it("a caller's own key wins over recognition", () => {
    expect(titleKeyFor("Anything", { key: "stored.titles.fromWeb", params: { query: "svømning" } })).toEqual({ titleKey: "stored.titles.fromWeb", titleParams: { query: "svømning" } });
    expect(titleKeyFor("Ida's birthday")).toEqual({ titleKey: null, titleParams: null });
  });
});

describe("source titles My Graph writes", () => {
  it("Aula's sensitive placeholder reads in Danish, including rows stored before keys", () => {
    const meta = { aula: { sensitive: true }, ...sourceTitleKey("aulaSensitive") };
    expect(localizeSourceTitle({ title: "Sensitive, open in Aula", meta }, da)).toBe("Følsom besked – åbn den i Aula");
    expect(localizeSourceTitle({ title: "Sensitive, open in Aula", meta: { aula: { sensitive: true } } }, da)).toBe("Følsom besked – åbn den i Aula");
    expect(localizeSourceTitle({ title: "Sensitive, open in Aula", meta }, en)).toBe("Sensitive, open in Aula");
    // Someone's own file that happens to have that name is left alone.
    expect(localizeSourceTitle({ title: "Sensitive, open in Aula", meta: {} }, da)).toBe("Sensitive, open in Aula");
    expect(localizeSourceTitle({ title: "Aula: Anna", meta: sourceTitleKey("aulaAccount", { name: "Anna" }) }, da)).toBe("Aula: Anna");
    expect(localizeSourceTitle({ title: "Aula: your login", meta: sourceTitleKey("aulaAccountUnknown") }, da)).toBe("Aula: dit login");
  });
});
