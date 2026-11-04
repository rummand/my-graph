/**
 * The library's words and dates in the reader's language (pure: server and client components both use it).
 * `Lx` carries the translator, language, time zone and whether family wording applies (only in a family graph).
 * Server: `await libraryLx(viewer)` (./server-lx). Client: `useLx(family)` (./use-lx).
 */
import { INTL_TAG, type Locale, type TFn } from "@/lib/i18n/core";
import { dayKey, formatDate } from "@/lib/i18n/dates";
import type { FileCategory } from "@/lib/ingest/mime";

export type Lx = { t: TFn; locale: Locale; timeZone: string; family: boolean };
export type Visibility = "private" | "parents" | "household";

const VIS: Visibility[] = ["private", "parents", "household"];

/** The three sharing choices, in family words in a family graph and in graph roles elsewhere. */
export function visibilityOptions(L: Lx): { value: Visibility; label: string; hint: string }[] {
  const set = L.family ? "family" : "graph";
  return VIS.map((value) => ({ value, label: L.t(`library.visibility.${set}.${value}.label`), hint: L.t(`library.visibility.${set}.${value}.hint`) }));
}

export const visibilityLabel = (L: Lx, v: Visibility) => L.t(`library.visibility.${L.family ? "family" : "graph"}.${v}.label`);

const DOC_KINDS = new Set(["mail", "letter", "scan", "photo", "recording", "note", "mailbox", "file", "web_page"]);
const CATEGORIES = new Set(["pdf", "document", "slides", "spreadsheet", "text", "image", "audio", "email", "mailbox", "other"]);

/** What people call an item: "Letter", "Scan", "Email", else the kind of file. */
export function kindWord(L: Pick<Lx, "t">, docKind: string | null | undefined, category: FileCategory): string {
  // A presentation or spreadsheet is called that, not "File" or "Note".
  if (docKind && DOC_KINDS.has(docKind) && category !== "slides" && category !== "spreadsheet") return L.t(`library.docKind.${docKind}`);
  return L.t(`library.kind.${CATEGORIES.has(category) ? category : "other"}`);
}

/** "a, b and c" / "a, b og c". */
export function listJoin(L: Pick<Lx, "t">, parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return L.t("library.join", { rest: parts.slice(0, -1).join(", "), last: parts[parts.length - 1] });
}

export type Counts = { people?: number; events?: number; other?: number; connections?: number; reminders?: number };

/** "2 people, 1 date and 3 connections": what reading a file found or proposed. */
export function countsLine(L: Pick<Lx, "t">, c: Counts): string {
  const parts = ([
    ["people", c.people], ["dates", c.events], ["things", c.other], ["connections", c.connections], ["reminders", c.reminders],
  ] as const).filter(([, n]) => !!n).map(([k, n]) => L.t(`library.count.${k}`, { count: n! }));
  return parts.length ? listJoin(L, parts) : L.t("library.count.nothingNew");
}

const NUM = (L: Pick<Lx, "locale">, n: number, digits: number) =>
  new Intl.NumberFormat(INTL_TAG[L.locale], { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

export function formatBytes(L: Pick<Lx, "t" | "locale">, n: number | null | undefined): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return L.t("library.bytes.b", { n });
  if (n < 1024 * 1024) return L.t("library.bytes.kb", { n: NUM(L, n / 1024, 0) });
  return L.t("library.bytes.mb", { n: NUM(L, n / 1024 / 1024, 1) });
}

const opts = (L: Pick<Lx, "locale" | "timeZone">, now?: Date) => ({ locale: L.locale, timeZone: L.timeZone, now });

/** "Today", "Yesterday", "Tue 3 Nov" (the year added when it isn't this year), in the reader's zone. */
export function formatDay(L: Lx, iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const k = dayKey(d, L.timeZone);
  if (k === dayKey(now, L.timeZone)) return L.t("library.day.today");
  if (k === dayKey(new Date(now.getTime() - 86_400_000), L.timeZone)) return L.t("library.day.yesterday");
  return formatDate(d, "weekday", opts(L, now));
}

/** "Tue 3 Nov at 20:57" / "tirs. 3. nov. kl. 20.57". */
export function formatMoment(L: Lx, iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return L.t("library.day.at", { day: formatDate(d, "weekday", opts(L, now)), time: formatDate(d, "time", opts(L, now)) });
}

/** A time of day ("14:05" / "14.05"), or null when the moment has no real time (midnight / end of day). */
export function timeOfDay(L: Lx, iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: L.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return hm === "00:00" || hm === "23:59" ? null : formatDate(d, "time", opts(L));
}

/**
 * A document's own date at its precision: "3 Mar 2024", "March 2024", "2024" (Danish: "3. mar. 2024", "marts 2024").
 * Day, month and year dates are calendar dates (stored at UTC midnight); only exact moments use the reader's zone.
 */
export function formatDocDate(L: Lx, iso: string, precision: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const timeZone = precision === "minute" ? L.timeZone : "UTC";
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(INTL_TAG[L.locale], { timeZone, ...o }).format(d);
  if (precision === "year") return f({ year: "numeric" });
  if (precision === "month") return f({ month: "long", year: "numeric" });
  return f({ day: "numeric", month: "short", year: "numeric" });
}

/** A date range for a conversation: "3 Mar 2024" or "3 Mar – 9 Apr 2024". */
export function formatSpan(L: Lx, a: string, b: string | null): string {
  const one = (x: string) => formatDocDate(L, x, "minute");
  if (!b) return one(a);
  const fa = one(a), fb = one(b);
  return fa === fb ? fa : `${fa} – ${fb}`;
}

/** What meta.extraction means, in plain words. Null when reading went fine. */
export function extractionNote(L: Pick<Lx, "t">, extraction: string | null): string | null {
  if (!extraction || extraction === "done") return null;
  if (extraction.startsWith("skipped: mux unreachable")) return L.t("library.extraction.muxDown");
  if (extraction.startsWith("skipped: no text")) return L.t("library.extraction.noText");
  if (extraction.startsWith("skipped: page could not be read")) return L.t("library.extraction.unread");
  if (extraction.startsWith("skipped: reading web pages is off")) return L.t("library.extraction.webOff");
  if (extraction.startsWith("failed")) return L.t("library.extraction.failed", { reason: extraction.replace(/^failed:\s*/, "") });
  if (extraction.startsWith("partial")) return L.t("library.extraction.partial", { reason: extraction.replace(/^partial:\s*/, "") });
  return L.t("library.extraction.other", { reason: extraction });
}

const ORIGINS = new Set(["email", "exif", "model", "text", "pdf", "parent"]);

/** Where a document's date came from, for its tooltip. */
export function dateOriginNote(L: Pick<Lx, "t">, from: { origin?: string; quote?: string | null } | null): string | undefined {
  if (!from?.origin) return undefined;
  const origin = ORIGINS.has(from.origin) ? L.t(`library.origin.${from.origin}`) : from.origin;
  return from.quote ? L.t("library.origin.fromQuote", { origin, quote: from.quote }) : L.t("library.origin.from", { origin });
}

/** Display name from an address header: `"Anna Holm" <anna@x.dk>` → Anna Holm. */
export const senderName = (from: string | null | undefined): string | null =>
  from ? from.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "").trim() || from : null;

const STEPS = new Set(["starting", "reading", "attachments", "splitting", "indexing", "adding", "finding", "proposing", "mail", "refreshing", "done"]);

/** What a running job is doing: "Finding people and dates, part 2 of 5", "Indexing for search, 64 of 120". */
export function stepText(L: Pick<Lx, "t">, p: { step: string; done?: number; total?: number; label?: string } | null | undefined): string {
  if (!p) return L.t("library.queue.step.starting");
  const step = STEPS.has(p.step) ? L.t(`library.queue.step.${p.step}`) : p.label ?? p.step;
  if (typeof p.total !== "number" || p.total <= 1 || typeof p.done !== "number") return step;
  if (p.step === "finding") return L.t("library.queue.stepPart", { step, done: Math.min(p.done + 1, p.total), total: p.total });
  return L.t("library.queue.stepOf", { step, done: p.done, total: p.total });
}
