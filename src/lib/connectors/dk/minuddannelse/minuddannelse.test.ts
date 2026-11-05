import { describe, expect, it } from "vitest";
import type { ImportKnown } from "@/lib/importers/types";
import { matchChild, readSchoolwork, remindAt, schoolworkImporter } from "./importer";
import {
  dayInWeek, hasWidget, isoWeek, meebookUrl, muUrl, planBatches, providerProblem, readMeebook, readOpgaver, readUgebrev, WeekBook, weekMonday,
  weeksToRead, widgetLogin, WIDGETS, type SchoolworkBatch,
} from "./widgets";

/* Fixtures in the shapes scaarup/aula reads (Aula profiles; MinUddannelse ugebrev/opgaveliste; Meebook relatedweekplan). */
const byLogin = {
  profiles: [{
    displayName: "Mette Hansen",
    institutionProfiles: [{ id: 1, institutionCode: "280012" }],
    children: [
      { id: 11, name: "Ida Hansen", userId: "idah1234", institutionProfile: { id: 111, institutionName: "Byskolen", institutionCode: "280012" } },
      { id: 12, name: "Karl Hansen", userId: "karl5678", institutionProfile: { id: 112, institutionName: "Byskolen", institutionCode: "280012" } },
    ],
  }],
};
const context = {
  userId: "mette9999",
  pageConfiguration: { widgetConfigurations: [{ widget: { widgetId: "0029", name: "Ugebrev" } }, { widget: { widgetId: "0030", name: "Opgaver" } }, { widget: { widgetId: "0004", name: "Meebook" } }] },
};
const ugebrev = {
  personer: [
    { navn: "Ida Hansen", institutioner: [{ ugebreve: [{ indhold: "<p>Kære forældre</p><p>På <b>fredag</b> tager vi i skoven. Husk madpakke og gummistøvler.</p>" }] }] },
    { navn: "Karl Hansen", institutioner: [{ ugebreve: [] }] },
  ],
};
const opgaver = {
  opgaver: [
    { id: 501, title: "Læs side 10-14", kuvertnavn: "Ida Hansen 3.A", ugedag: "Torsdag", opgaveType: "Lektie", erFaerdig: false, hold: [{ navn: "Dansk" }], forloeb: { navn: "Eventyr" }, url: "https://www.minuddannelse.net/opgave/501" },
    { id: 502, title: "Gangestykker", kuvertnavn: "Ida Hansen 3.A", ugedag: "Mandag", erFaerdig: true, hold: [{ navn: "Matematik" }] },
    { title: "Tegn en fugl", kuvertnavn: "Karl Hansen 0.B", ugedag: "Fredag", erFaerdig: false, url: "javascript:alert(1)" },
  ],
};
const meebook = [
  {
    id: 1, name: "Karl Hansen", unilogin: "karl5678",
    weekPlan: [
      { date: "mandag 2. nov.", tasks: [{ id: 9, type: "comment", group: "0.B - ugeplan", pill: "Ingen fag tilknyttet", author: "Lise Lærer", content: "<p>Velkommen til uge 45.</p>" }] },
      { date: "onsdag 4. nov.", tasks: [{ id: 10, type: "assignment", pill: "Dansk", title: "Find tre ord der rimer" }] },
      { date: "torsdag 5. nov.", tasks: [] },
    ],
  },
];

describe("weeks", () => {
  it("names ISO weeks the way the providers want them", () => {
    expect(isoWeek(new Date("2026-11-05T10:00:00Z"))).toBe("2026-W45");
    expect(isoWeek(new Date("2027-01-01T10:00:00Z"))).toBe("2026-W53");
    expect(weekMonday("2026-W45")).toBe("2026-11-02");
    expect(weekMonday("2027-W01")).toBe("2027-01-04");
  });
  it("reads this week and next, on the Copenhagen day", () => {
    expect(weeksToRead(new Date("2026-11-08T23:30:00Z"))).toEqual(["2026-W46", "2026-W47"]); // already Monday in Copenhagen
  });
  it("places a weekday or a Danish date label in the week", () => {
    expect(dayInWeek("2026-W45", "Torsdag")).toBe("2026-11-05");
    expect(dayInWeek("2026-W45", "onsdag 4. nov.")).toBe("2026-11-04");
    expect(dayInWeek("2026-W45", "2026-11-06")).toBe("2026-11-06");
    expect(dayInWeek("2026-W45", "someday")).toBeNull();
  });
});

describe("the Aula login, for the widgets", () => {
  const l = widgetLogin(byLogin, context);
  it("finds the children's UNI-login ids, the institutions and the widgets", () => {
    expect(l.guardianId).toBe("mette9999");
    expect(l.children.map((c) => c.uniId)).toEqual(["idah1234", "karl5678"]);
    expect(l.institutionCodes).toEqual(["280012"]);
    expect(hasWidget(l, WIDGETS.muPlan)).toBe(true);
    expect(hasWidget(l, ["0099"])).toBe(false);
  });
  it("treats a missing widget list as unknown (try), not as none", () => {
    expect(hasWidget(widgetLogin(byLogin, { userId: "x" }), WIDGETS.meebook)).toBe(true);
  });
  it("builds the providers' addresses", () => {
    const u = new URL(muUrl("ugebrev", l, "2026-W45"));
    expect(u.host).toBe("api.minuddannelse.net");
    expect(u.pathname).toBe("/aula/ugebrev");
    expect(u.searchParams.get("childFilter")).toBe("idah1234,karl5678");
    expect(u.searchParams.get("sessionUUID")).toBe("mette9999");
    expect(u.searchParams.get("currentWeekNumber")).toBe("2026-W45");
    const m = new URL(meebookUrl(l, "2026-W45"));
    expect(m.host).toBe("app.meebook.com");
    expect(m.searchParams.getAll("childFilter[]")).toEqual(["idah1234", "karl5678"]);
    expect(m.searchParams.getAll("institutionFilter[]")).toEqual(["280012"]);
  });
});

describe("reading the providers' answers", () => {
  const children = widgetLogin(byLogin, context).children;
  const book = new WeekBook(children);
  readUgebrev(book, "2026-W45", ugebrev);
  readOpgaver(book, "2026-W45", opgaver);
  readMeebook(book, "2026-W45", meebook);
  const weeks = book.all();
  const ida = weeks.find((w) => w.child === "Ida Hansen")!;
  const karl = weeks.find((w) => w.child === "Karl Hansen")!;

  it("turns the weekly letter into plain text for the right child", () => {
    expect(ida.plans).toHaveLength(1);
    expect(ida.plans[0].text).toContain("tager vi i skoven");
    expect(ida.plans[0].text).not.toContain("<p>");
  });
  it("reads assignments with subject, due day and done", () => {
    const a = ida.assignments.find((x) => x.key === "mu:501")!;
    expect(a).toMatchObject({ title: "Læs side 10-14", subject: "Dansk, Eventyr", due: "2026-11-05", done: false, url: "https://www.minuddannelse.net/opgave/501" });
    expect(ida.assignments.find((x) => x.key === "mu:502")!.done).toBe(true);
  });
  it("drops unsafe links and keys assignments without an id stably", () => {
    const a = karl.assignments.find((x) => x.title === "Tegn en fugl")!;
    expect(a.url).toBeNull();
    expect(a.key).toMatch(/^mu:[0-9a-f]{24}$/);
  });
  it("reads Meebook's days, leaving out the 'no subject' pill and empty days", () => {
    const plan = karl.plans.find((p) => p.provider === "meebook")!;
    expect(plan.text).toContain("Velkommen til uge 45.");
    expect(plan.text).not.toContain("Ingen fag tilknyttet");
    expect(plan.text).not.toContain("torsdag");
    expect(karl.assignments.find((x) => x.key === "meebook:10")).toMatchObject({ title: "Find tre ord der rimer", subject: "Dansk", due: "2026-11-04" });
  });
  it("recognises an error answer", () => {
    expect(providerProblem({ message: "Token expired" })).toBe("Token expired");
    expect(providerProblem(ugebrev)).toBeNull();
    expect(providerProblem(meebook)).toBeNull();
  });

  it("hands over changed weeks only, and reminds once per assignment version", () => {
    const first = planBatches(weeks, {}, "2026-11-04");
    expect(first.batches).toHaveLength(2);
    const idaBatch = first.batches.find((b) => b.batch.child === "Ida Hansen")!;
    expect(idaBatch.externalId).toBe("schoolwork:idah1234:2026-W45");
    const remind = Object.fromEntries(idaBatch.batch.assignments.map((a) => [a.key, a.remind]));
    expect(remind).toEqual({ "mu:501": true, "mu:502": false });
    // Karl's Monday-due one is past (today is Wednesday); Wednesday's is due today.
    expect(first.batches.find((b) => b.batch.child === "Karl Hansen")!.batch.assignments.find((a) => a.key === "meebook:10")!.remind).toBe(true);

    const again = planBatches(weeks, first.next, "2026-11-04");
    expect(again.batches).toHaveLength(0);

    // The teacher edits the letter: the week goes over again, but the unchanged assignment isn't reminded twice.
    const edited = weeks.map((w) => (w.child === "Ida Hansen" ? { ...w, plans: [{ ...w.plans[0], text: `${w.plans[0].text} Tag regntøj med.` }] } : w));
    const third = planBatches(edited, first.next, "2026-11-04");
    expect(third.batches).toHaveLength(1);
    expect(third.batches[0].batch.assignments.find((a) => a.key === "mu:501")!.remind).toBe(false);
  });
});

describe("the schoolwork importer", () => {
  const known: ImportKnown[] = [
    { id: "n-ida", type: "person", kind: "child", label: "Ida", aliases: [], startAt: null, props: {} },
    { id: "n-mette", type: "person", kind: null, label: "Mette Hansen", aliases: [], startAt: null, props: {} },
  ];
  const batch: SchoolworkBatch = {
    format: "mygraph.schoolwork.v1", child: "Ida Hansen", week: "2026-W45", weekStart: "2026-11-02",
    plans: [{ provider: "minuddannelse", heading: null, text: "På fredag tager vi i skoven." }],
    assignments: [
      { key: "mu:501", provider: "minuddannelse", title: "Læs side 10-14", subject: "Dansk", due: "2026-11-05", done: false, text: null, url: "https://www.minuddannelse.net/opgave/501", remind: true },
      { key: "mu:503", provider: "minuddannelse", title: "Øv tabeller", subject: null, due: "2026-11-06", done: false, text: null, url: null, remind: false },
      { key: "mu:502", provider: "minuddannelse", title: "Gangestykker", subject: "Matematik", due: "2026-11-02", done: true, text: null, url: null, remind: true },
    ],
  };
  const now = new Date("2026-11-03T09:00:00Z");
  const plan = readSchoolwork(Buffer.from(JSON.stringify(batch)), { known, now, locale: "en" });

  it("never claims an upload", () => {
    expect(schoolworkImporter.detect({ filename: "x.json", head: new TextEncoder().encode(JSON.stringify(batch)) })).toBe(false);
  });
  it("keeps the plan and the assignments as searchable text, read on by the model", () => {
    const text = plan.segments.map((s) => s.text).join("\n");
    expect(text).toContain("På fredag tager vi i skoven.");
    expect(text).toContain("- Dansk: Læs side 10-14 (due 2026-11-05)");
    expect(plan.extract).toBe(true);
    expect(plan.title).toBe("Weekly plan, week 45: Ida Hansen");
    expect(plan.occurredAt?.toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });
  it("proposes one reminder per flagged open assignment, for the child, quoting its line", () => {
    expect(plan.changes).toHaveLength(1);
    const r = plan.changes[0];
    expect(r).toMatchObject({ op: "addReminder", aboutNodeId: "n-ida", title: "Ida: Læs side 10-14" });
    const text = plan.segments.map((s) => s.text).join("\n");
    expect(text).toContain(r.receipt!.quote!);
    expect(r.receipt!.url).toBe("https://www.minuddannelse.net/opgave/501");
    // 16:00 in Copenhagen (UTC+1 in November) the day before.
    expect((r as { dueAt: string }).dueAt).toBe("2026-11-04T15:00:00.000Z");
  });
  it("writes its own words in Danish for a Danish reader", () => {
    const da = readSchoolwork(Buffer.from(JSON.stringify(batch)), { known, now, locale: "da" });
    expect(da.title).toBe("Ugeplan, uge 45: Ida Hansen");
    expect(da.segments.map((s) => s.text).join("\n")).toContain("(til 2026-11-05)");
  });
  it("refuses a batch in another shape", () => {
    expect(() => readSchoolwork(Buffer.from(JSON.stringify({ ...batch, format: "other" })), { known, now, locale: "en" })).toThrow();
  });
  it("matches children by full name, else by a unique first name among children", () => {
    expect(matchChild(known, "Ida Hansen")?.id).toBe("n-ida");
    expect(matchChild([...known, { ...known[0], id: "n-ida2" }], "Ida Hansen")).toBeNull();
    expect(matchChild(known, "Mette Hansen")?.id).toBe("n-mette");
  });
  it("reminds in summer time too, and never in the past", () => {
    expect(remindAt("2026-06-10", new Date("2026-06-01T00:00:00Z"))).toBe("2026-06-09T14:00:00.000Z");
    const late = new Date("2026-11-04T20:00:00Z");
    expect(remindAt("2026-11-05", late)).toBe(late.toISOString());
  });
});
