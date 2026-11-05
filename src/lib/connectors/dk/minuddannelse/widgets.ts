/**
 * MinUddannelse and Meebook through Aula's widgets (pure: no DB, no network).
 *
 * Aula shows weekly plans (ugeplaner/ugebreve) and homework (opgaver) from MinUddannelse and Meebook as widgets. A
 * widget gets a short-lived token from the parent's Aula session (`aulaToken.getAulaToken&widgetId=…`) and calls the
 * provider's own Aula API with it. The endpoints, widget ids and answer shapes follow scaarup/aula (the Home Assistant
 * Aula integration, custom_components/aula/client.py and const.py):
 *
 *   MinUddannelse  api.minuddannelse.net/aula
 *                  /ugebrev?assuranceLevel=2&childFilter=<uni ids, comma>&currentWeekNumber=YYYY-Www&isMobileApp=false
 *                    &placement=narrow&sessionUUID=<guardian userId>&userProfile=guardian           (widget 0029, 0023)
 *                    → { personer: [{ navn, institutioner: [{ ugebreve: [{ indhold: "<html>" }] }] }] }
 *                  /opgaveliste?… (same parameters)                                                    (widget 0030, 0023)
 *                    → { opgaver: [{ title, kuvertnavn, ugedag, opgaveType, erFaerdig, hold: [{ navn }], forloeb: { navn }, url }] }
 *   Meebook        app.meebook.com/aulaapi/relatedweekplan/all?currentWeekNumber=YYYY-Www&userProfile=guardian
 *                    &childFilter[]=<uni id>…&institutionFilter[]=<institution code>…                   (widget 0004)
 *                    → [{ name, unilogin, weekPlan: [{ date: "mandag 28. nov.", tasks: [{ id, type, pill, author, content | title, group }] }] }]
 *
 * Every field is read tolerantly: a renamed or missing field is skipped, never fatal. Nothing here is official;
 * neither provider offers parents an API. What the plans say is data, never instructions.
 */
import { createHash } from "node:crypto";
import { htmlToText } from "@/lib/ingest/email";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : null);

export const MU_API = "https://api.minuddannelse.net/aula";
export const MEEBOOK_API = "https://app.meebook.com/aulaapi";

/** Widget ids in Aula (scaarup/aula const MU_UGEPLAN_WIDGETS, MU_OPGAVER_WIDGETS; Meebook 0004). */
export const WIDGETS = { muPlan: ["0029", "0023"], muTasks: ["0030", "0023"], meebook: ["0004"] } as const;

export type Provider = "minuddannelse" | "meebook";

export const fingerprint = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 24);
const firstName = (s: string) => s.normalize("NFKC").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/* ── Weeks ────────────────────────────────────────────────────────────────────────────────────────────── */

/** ISO week of a day, as the providers want it: "2026-W45" (Python's %G-W%V). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of an ISO week ("2026-W45" → "2026-11-02"). */
export function weekMonday(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`Not an ISO week: ${week}`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/** This week and next (a weekly plan for next week usually arrives on Friday). Uses the Copenhagen day. */
export function weeksToRead(now: Date): string[] {
  const day = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(now)}T12:00:00Z`);
  return [isoWeek(day), isoWeek(new Date(day.getTime() + 7 * 86_400_000))];
}

const WEEKDAYS: Record<string, number> = {
  mandag: 0, tirsdag: 1, onsdag: 2, torsdag: 3, fredag: 4, lordag: 5, lørdag: 5, sondag: 6, søndag: 6,
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};

/** "Mandag", "mandag 28. nov." or a date → the day in that week ("YYYY-MM-DD"), or null. */
export function dayInWeek(week: string, label: string | null): string | null {
  if (!label) return null;
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(label);
  if (iso) return iso[1];
  const w = label.trim().toLowerCase().split(/[\s,.]+/)[0];
  const n = WEEKDAYS[w];
  if (n === undefined) return null;
  const mon = new Date(`${weekMonday(week)}T00:00:00Z`);
  return new Date(mon.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/* ── Aula: who is signed in, the children's UNI-login ids, which widgets this login has ─────────────── */

export type SchoolChild = { name: string; uniId: string; institutionCode: string | null; institutionName: string | null };
export type WidgetLogin = { guardianId: string | null; children: SchoolChild[]; institutionCodes: string[]; widgets: Set<string> | null };

/** profiles.getProfilesByLogin + profiles.getProfileContext → what the widgets need. */
export function widgetLogin(byLogin: unknown, context: unknown): WidgetLogin {
  const children: SchoolChild[] = [];
  const codes = new Set<string>();
  const seen = new Set<string>();
  for (const p of arr(obj(byLogin).profiles)) {
    const prof = obj(p);
    for (const ip of arr(prof.institutionProfiles)) {
      const c = str(obj(ip).institutionCode, 40);
      if (c) codes.add(c);
    }
    for (const c of arr(prof.children)) {
      const ch = obj(c);
      const ip = obj(ch.institutionProfile);
      const uniId = str(ch.userId ?? ip.userId, 80);
      const name = str(ch.name ?? ip.fullName ?? ip.name ?? ch.displayName, 160);
      if (!uniId || !name || seen.has(uniId)) continue;
      seen.add(uniId);
      const code = str(ip.institutionCode ?? ch.institutionCode, 40);
      if (code) codes.add(code);
      children.push({ name, uniId, institutionCode: code, institutionName: str(ip.institutionName ?? ch.institutionName, 200) });
    }
  }
  const ctx = obj(context);
  const guardianId = str(ctx.userId ?? obj(ctx.institutionProfile).userId, 120);
  // The widget list moved over time: pageConfiguration.widgetConfigurations (scaarup/aula today) or
  // moduleWidgetConfiguration.widgetConfigurations (older answers).
  const confs = [...arr(obj(ctx.pageConfiguration).widgetConfigurations), ...arr(obj(ctx.moduleWidgetConfiguration).widgetConfigurations)];
  const widgets = new Set<string>();
  for (const w of confs) {
    const id = str(obj(obj(w).widget).widgetId ?? obj(w).widgetId, 10);
    if (id) widgets.add(id);
  }
  return { guardianId, children, institutionCodes: [...codes], widgets: confs.length ? widgets : null };
}

/** Does this login have one of these widgets? Unknown (no list in Aula's answer) counts as yes: we try. */
export const hasWidget = (l: WidgetLogin, ids: readonly string[]) => !l.widgets || ids.some((id) => l.widgets!.has(id));

/* ── Request addresses ───────────────────────────────────────────────────────────────────────────────── */

export function muUrl(path: "ugebrev" | "opgaveliste", l: WidgetLogin, week: string, base = MU_API): string {
  const q = new URLSearchParams({
    assuranceLevel: "2", childFilter: l.children.map((c) => c.uniId).join(","), currentWeekNumber: week,
    isMobileApp: "false", placement: "narrow", sessionUUID: l.guardianId ?? "", userProfile: "guardian",
  });
  return `${base}/${path}?${q.toString()}`;
}

export function meebookUrl(l: WidgetLogin, week: string, base = MEEBOOK_API): string {
  const q = new URLSearchParams({ currentWeekNumber: week, userProfile: "guardian" });
  for (const c of l.children) q.append("childFilter[]", c.uniId);
  for (const i of l.institutionCodes) q.append("institutionFilter[]", i);
  return `${base}/relatedweekplan/all?${q.toString()}`;
}

/* ── What the providers answer, normalised ───────────────────────────────────────────────────────────── */

export type Assignment = {
  /** Stable at the provider when it gives one; else built from the child, week, day and title. */
  key: string;
  provider: Provider;
  title: string;
  subject: string | null;
  /** The day it is for (YYYY-MM-DD), when known. */
  due: string | null;
  done: boolean;
  text: string | null;
  url: string | null;
};

export type PlanPart = { provider: Provider; heading: string | null; text: string };

export type ChildWeek = { child: string; uniId: string | null; week: string; plans: PlanPart[]; assignments: Assignment[] };

const clean = (html: string | null): string => (html ? htmlToText(html).replace(/\n{3,}/g, "\n\n").trim() : "");

function childFor(children: SchoolChild[], name: string | null): SchoolChild | null {
  if (!name) return children.length === 1 ? children[0] : null;
  const n = name.normalize("NFKC").toLowerCase().trim();
  const exact = children.find((c) => c.name.normalize("NFKC").toLowerCase() === n);
  if (exact) return exact;
  const byFirst = children.filter((c) => firstName(c.name) === firstName(name));
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Collects parts per child per week. */
export class WeekBook {
  private readonly map = new Map<string, ChildWeek>();
  constructor(private readonly children: SchoolChild[]) {}
  for(name: string | null, week: string, uniId?: string | null): ChildWeek | null {
    const c = (uniId && this.children.find((x) => x.uniId === uniId)) || childFor(this.children, name);
    const child = c?.name ?? name;
    if (!child) return null;
    const k = `${c?.uniId ?? child.toLowerCase()}|${week}`;
    let w = this.map.get(k);
    if (!w) this.map.set(k, (w = { child, uniId: c?.uniId ?? null, week, plans: [], assignments: [] }));
    return w;
  }
  all(): ChildWeek[] {
    return [...this.map.values()].filter((w) => w.plans.length || w.assignments.length);
  }
}

/** MinUddannelse /ugebrev → one plan part per child (every institution's letters, joined). */
export function readUgebrev(book: WeekBook, week: string, data: unknown): number {
  let n = 0;
  for (const p of arr(obj(data).personer)) {
    const person = obj(p);
    const name = str(person.navn, 160);
    const parts: string[] = [];
    for (const inst of arr(person.institutioner)) {
      const i = obj(inst);
      for (const u of arr(i.ugebreve)) {
        const t = clean(str(obj(u).indhold, 200_000));
        if (t) parts.push(t);
      }
    }
    if (!parts.length) continue;
    const w = book.for(name, week);
    if (!w) continue;
    w.plans.push({ provider: "minuddannelse", heading: null, text: parts.join("\n\n") });
    n++;
  }
  return n;
}

/** MinUddannelse /opgaveliste → assignments, each placed with its child (kuvertnavn starts with the child's name). */
export function readOpgaver(book: WeekBook, week: string, data: unknown): number {
  let n = 0;
  for (const raw of arr(obj(data).opgaver)) {
    const o = obj(raw);
    const title = str(o.title ?? o.titel, 300);
    if (!title) continue;
    const w = book.for(str(o.kuvertnavn, 160), week);
    if (!w) continue;
    const hold = arr(o.hold).map((h) => str(obj(h).navn, 80)).filter((x): x is string => !!x);
    const forloeb = str(obj(o.forloeb).navn, 160);
    const subject = [...hold, forloeb].filter(Boolean).join(", ") || str(o.opgaveType, 60);
    const due = dayInWeek(week, str(o.dato ?? o.afleveringsdato, 40)) ?? dayInWeek(week, str(o.ugedag, 40));
    const id = str(o.id ?? o.opgaveId, 80);
    w.assignments.push({
      key: id ? `mu:${id}` : `mu:${fingerprint([w.child, week, due, title])}`, provider: "minuddannelse", title, subject: subject || null, due,
      done: o.erFaerdig === true, text: clean(str(o.beskrivelse ?? o.indhold ?? o.kommentar, 20_000)) || null, url: safeUrl(o.url),
    });
    n++;
  }
  return n;
}

const NO_SUBJECT = /^ingen fag tilknyttet$/i;

/** Meebook /relatedweekplan/all → per child: the plan (comments and tasks per day) and assignments due that day. */
export function readMeebook(book: WeekBook, week: string, data: unknown): number {
  let n = 0;
  for (const p of arr(data)) {
    const person = obj(p);
    const w = book.for(str(person.name, 160), week, str(person.unilogin, 80));
    if (!w) continue;
    const lines: string[] = [];
    for (const d of arr(person.weekPlan)) {
      const day = obj(d);
      const label = str(day.date, 60);
      const tasks = arr(day.tasks).map(obj);
      if (!tasks.length) continue;
      lines.push(`${label ?? ""}`.trim());
      for (const t of tasks) {
        const type = str(t.type, 20)?.toLowerCase() ?? "comment";
        const pill = str(t.pill, 200);
        const subject = pill && !NO_SUBJECT.test(pill) ? pill : null;
        const body = clean(str(type === "assignment" ? t.title ?? t.content : t.content ?? t.title, 20_000));
        if (!body) continue;
        const author = str(t.author, 120);
        lines.push(`${subject ? `${subject}: ` : ""}${body}${author ? ` (${author})` : ""}`);
        if (type === "assignment" || type === "task") {
          const id = str(t.id, 80);
          const due = dayInWeek(week, label);
          const title = body.split("\n")[0].slice(0, 200);
          w.assignments.push({
            key: id ? `meebook:${id}` : `meebook:${fingerprint([w.child, week, due, title])}`, provider: "meebook", title, subject,
            due, done: false, text: body.length > title.length ? body : null, url: safeUrl(t.editUrl ?? t.url),
          });
        }
      }
      lines.push("");
    }
    const text = lines.join("\n").trim();
    if (text) { w.plans.push({ provider: "meebook", heading: null, text }); n++; }
  }
  return n;
}

function safeUrl(v: unknown): string | null {
  const s = str(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Why a provider answer is an error, if it is one (Meebook answers { message: "… expired" } or { exceptionMessage }). */
export function providerProblem(data: unknown): string | null {
  const o = obj(data);
  const m = str(o.exceptionMessage ?? o.message ?? o.error, 200);
  return m && !Array.isArray(data) && !o.personer && !o.opgaver ? m : null;
}

/* ── The batch handed to the schoolwork importer ─────────────────────────────────────────────────────── */

export const SCHOOLWORK_FORMAT = "mygraph.schoolwork.v1";

export type SchoolworkBatch = {
  format: typeof SCHOOLWORK_FORMAT;
  child: string;
  week: string;
  /** Monday of the week, YYYY-MM-DD. */
  weekStart: string;
  plans: PlanPart[];
  assignments: (Assignment & { remind: boolean })[];
};

/** What decides whether a week changed (reminder flags left out, so marking one as reminded never rereads the plan). */
export const contentFingerprint = (w: ChildWeek) => fingerprint([w.child, w.week, w.plans, w.assignments]);
export const assignmentFingerprint = (a: Assignment) => fingerprint([a.title, a.due, a.text, a.subject]);

export type SchoolCursor = {
  /** externalId → content fingerprint of the week last handed over. */
  weeks?: Record<string, string>;
  /** assignment key → fingerprint of the version a reminder was proposed for. */
  reminded?: Record<string, string>;
};

export const weekExternalId = (w: Pick<ChildWeek, "child" | "uniId" | "week">) => `schoolwork:${w.uniId ?? firstName(w.child)}:${w.week}`;

/**
 * What to hand over this run: weeks whose content changed, each with the assignments that get a reminder (new or
 * changed, not done, not past). Returns the next cursor (kept small: the newest 400 of each).
 */
export function planBatches(weeks: ChildWeek[], cur: SchoolCursor, today: string): { batches: { externalId: string; batch: SchoolworkBatch }[]; next: SchoolCursor } {
  const nextWeeks = { ...(cur.weeks ?? {}) };
  const reminded = { ...(cur.reminded ?? {}) };
  const batches: { externalId: string; batch: SchoolworkBatch }[] = [];
  for (const w of weeks) {
    const externalId = weekExternalId(w);
    const fp = contentFingerprint(w);
    if (nextWeeks[externalId] === fp) continue;
    nextWeeks[externalId] = fp;
    const assignments = w.assignments.map((a) => {
      const afp = assignmentFingerprint(a);
      const remind = !a.done && !!a.due && a.due >= today && reminded[a.key] !== afp;
      if (remind) reminded[a.key] = afp;
      return { ...a, remind };
    });
    batches.push({ externalId, batch: { format: SCHOOLWORK_FORMAT, child: w.child, week: w.week, weekStart: weekMonday(w.week), plans: w.plans, assignments } });
  }
  const trim = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).slice(-400));
  return { batches, next: { weeks: trim(nextWeeks), reminded: trim(reminded) } };
}
