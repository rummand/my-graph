import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, ArrowLeft, Bell, CircleCheck, ExternalLink, LoaderCircle, Lock, MapPin, ShieldAlert, Users, UsersRound } from "lucide-react";
import { NodeChip, PersonChip } from "@/components/ui";
import { AudioTranscript } from "@/components/library/audio-transcript";
import { CiteButton, MarkedText, PassageList, PdfFrame, ProvenanceProvider } from "@/components/library/provenance";
import { SharingSettings, SourceSettings } from "@/components/library/source-settings";
import { extractionNote, formatBytes, formatDay, formatMoment, isStuck, KIND_WORD, StatusPill, visibilityLabel } from "@/components/library/source-meta";
import { StatusWatcher } from "@/components/library/status-watcher";
import { requireUser, type Viewer } from "@/lib/auth";
import { listReminders, type ReminderDTO } from "@/lib/briefs";
import { formatTime } from "@/lib/ingest/chunk";
import { getSourceDetail, type ExtractedFact, type SourceDetail } from "@/lib/ingest/library";
import { getMeta } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "File · My Graph" };

type Detail = SourceDetail;
type Chunk = Detail["chunks"][number];

async function relationLabeller(v: Viewer): Promise<(key: string) => string> {
  try {
    const meta = await getMeta(v);
    return (k) => meta.relationLabel(k);
  } catch {
    return (k) => k.replace(/_/g, " ");
  }
}

async function remindersFrom(v: Viewer, sourceId: string): Promise<ReminderDTO[]> {
  try {
    return (await listReminders(v, { includeDone: true, limit: 200 })).filter((r) => r.sourceId === sourceId);
  } catch {
    return [];
  }
}

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const v = await requireUser();
  const d = await getSourceDetail(v, id);
  if (!d) notFound();
  const [label, reminders] = await Promise.all([relationLabeller(v), remindersFrom(v, id)]);
  const s = d.source;
  const stuck = isStuck(s.status, s.startedAt, s.createdAt);
  const busy = (s.status === "pending" || s.status === "processing") && !stuck;
  const VisIcon = s.visibility === "private" ? Lock : s.visibility === "parents" ? UsersRound : Users;

  return (
    <ProvenanceProvider>
      <StatusWatcher active={busy} />
      <Link href="/library" className="mb-5 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />Library
      </Link>

      <header className="mb-8">
        <h1 className="break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{s.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <span>
            {KIND_WORD[s.category]} added {formatMoment(s.createdAt)} by {s.isOwner ? "you" : s.ownerName ?? "someone in the family"}
            {s.size ? `, ${formatBytes(s.size)}` : ""}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg">
            <VisIcon aria-hidden className="size-3.5 text-muted" />{visibilityLabel(s.visibility)}
          </span>
          {s.sensitive && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warn-tint px-2 py-0.5 text-xs font-medium text-warn">
              <ShieldAlert aria-hidden className="size-3.5" />Sensitive
            </span>
          )}
          <StatusPill status={s.status} stuck={stuck} />
        </div>
      </header>

      <FoundSummary d={d} reminders={reminders.length} />

      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-8">
          <Original d={d} />
          <ReadText d={d} />
        </div>

        <aside className="min-w-0 space-y-10" aria-label="What was found in this file">
          <Learned d={d} busy={busy} stuck={stuck} reminders={reminders} label={label} />

          <section aria-labelledby="sharing-h">
            <h2 id="sharing-h" className="mb-4 text-lg font-semibold tracking-[-0.01em]">Sharing</h2>
            {s.isOwner ? (
              <SharingSettings id={s.id} visibility={s.visibility} sensitive={s.sensitive} />
            ) : (
              <p className="text-sm text-muted">
                {s.ownerName ?? "Someone"} added this file and shares it with {s.visibility === "household" ? "the whole family" : s.visibility === "parents" ? "the parents" : "you"}.
                Only they can change who sees it.
              </p>
            )}
          </section>

          {s.isOwner && (
            <section aria-labelledby="file-h">
              <h2 id="file-h" className="mb-4 text-lg font-semibold tracking-[-0.01em]">The file</h2>
              <SourceSettings id={s.id} title={s.title} visibility={s.visibility} sensitive={s.sensitive} hasFile={!!s.mime} busy={busy} />
            </section>
          )}
        </aside>
      </div>
    </ProvenanceProvider>
  );
}

/** Phones: the findings sit below the original, so say up front what is there and link to it. */
function FoundSummary({ d, reminders }: { d: Detail; reminders: number }) {
  const people = d.entities.filter((e) => e.type === "person").length;
  const dates = d.entities.filter((e) => e.type === "event").length;
  const parts = [
    people && `${people} ${people === 1 ? "person" : "people"}`,
    dates && `${dates} ${dates === 1 ? "date" : "dates"}`,
    reminders && `${reminders} ${reminders === 1 ? "reminder" : "reminders"}`,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return (
    <a href="#learned-h" className="-mt-4 mb-6 flex items-center justify-between gap-3 rounded-lg bg-accent-tint px-4 py-3 text-sm text-accent lg:hidden">
      <span>Found {list} in this file</span><span aria-hidden>See them</span>
    </a>
  );
}

/* ── The original ─────────────────────────────────────────────────────────────────────────────────────────── */

function Original({ d }: { d: Detail }) {
  const s = d.source;
  const url = `/api/files/${s.id}`;
  const exif = (s.meta.exif ?? null) as { takenAt: string | null; lat: number | null; lon: number | null; camera: string | null } | null;
  const email = (s.meta.email ?? null) as { subject: string | null; from: string | null; date: string | null } | null;
  const caption = typeof s.meta.captionText === "string" ? s.meta.captionText : null;

  if (s.category === "image") {
    const details: [string, React.ReactNode][] = [];
    // The description is also the photo's first passage; show it once, where citations can point at it.
    if (caption && d.chunks.length === 0) details.push(["What's in it", caption]);
    if (exif?.takenAt) details.push(["Taken", formatMoment(exif.takenAt)]);
    if (exif?.lat != null && exif?.lon != null) {
      details.push(["Where", (
        <a key="map" className="inline-flex items-center gap-1 text-accent hover:underline" target="_blank" rel="noreferrer noopener"
          href={`https://www.openstreetmap.org/?mlat=${exif.lat}&mlon=${exif.lon}#map=16/${exif.lat}/${exif.lon}`}>
          <MapPin aria-hidden className="size-3.5" />Open the place on a map
        </a>
      )]);
    }
    if (exif?.camera) details.push(["Camera", exif.camera]);
    return (
      <section aria-label="The original photo">
        {s.mime === "image/heic" ? (
          <div className="rounded-lg bg-surface p-8 text-sm text-muted">
            This browser can&apos;t show HEIC photos. <a className="text-accent hover:underline" href={`${url}?download=1`}>Download the original</a> to see it.
          </div>
        ) : (
          <figure className="flex justify-center overflow-hidden rounded-lg bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated original */}
            <img src={url} alt={caption ?? s.title} className="max-h-[78vh] w-auto max-w-full object-contain" />
          </figure>
        )}
        {details.length > 0 && <Details rows={details} />}
      </section>
    );
  }

  if (s.category === "pdf") {
    return (
      <section aria-label="The original PDF">
        <div className="overflow-hidden rounded-lg bg-surface">
          <PdfFrame url={url} title={s.title} />
        </div>
        <a className="mt-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg" href={url} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden className="size-3.5" />Open the PDF in its own tab
        </a>
      </section>
    );
  }

  if (s.category === "audio") {
    return (
      <section aria-label="The recording and its transcript" className="overflow-hidden rounded-lg bg-surface">
        <AudioTranscript src={url} title={s.title}
          segments={d.chunks.map((c) => ({ id: c.id, text: c.text, start: c.locator.timeStartSec ?? null, end: c.locator.timeEndSec ?? null }))} />
      </section>
    );
  }

  // Letters, notes, Word documents and emails: the text itself, on a page.
  const text = s.textContent ?? "";
  const emailRows: [string, React.ReactNode][] = [];
  if (email?.subject) emailRows.push(["Subject", email.subject]);
  if (email?.from) emailRows.push(["From", email.from]);
  if (email?.date) emailRows.push(["Sent", formatMoment(email.date)]);
  return (
    <section aria-label="The original text" className="rounded-lg bg-surface px-5 py-6 sm:px-10 sm:py-9">
      {emailRows.length > 0 && <div className="mb-6 border-b border-line pb-4"><Details rows={emailRows} flush /></div>}
      {text.trim() ? (
        <div className="max-h-[78vh] overflow-y-auto">
          <MarkedText rangeFromLocator text={text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text}
            className="max-w-[68ch] whitespace-pre-wrap break-words text-[15px] leading-7" />
        </div>
      ) : (
        <p className="text-sm text-muted">{s.status === "ready" ? "No text was found in this file." : "The text appears here once the file has been read."}</p>
      )}
    </section>
  );
}

function Details({ rows, flush = false }: { rows: [string, React.ReactNode][]; flush?: boolean }) {
  return (
    <dl className={flush ? "grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[6rem_1fr]" : "mt-4 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[7rem_1fr]"}>
      {rows.map(([k, val]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-words">{val}</dd>
        </div>
      ))}
    </dl>
  );
}

/** For PDFs and photos: the words read out of the file, passage by passage, so a citation has somewhere to point. */
function ReadText({ d }: { d: Detail }) {
  const s = d.source;
  if (s.category !== "pdf" && s.category !== "image") return null;
  if (d.chunks.length === 0) {
    if (s.category === "image") return null;
    return (
      <section>
        <h2 className="mb-2 text-lg font-semibold tracking-[-0.01em]">Text read from the PDF</h2>
        <p className="text-sm text-muted">{s.status === "ready" ? "No text was found. If this is a scan, the words may be too faint to read." : "The text appears here once the file has been read."}</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold tracking-[-0.01em]">{s.category === "pdf" ? "Text read from the PDF" : "What was read from the photo"}</h2>
      <PassageList chunks={d.chunks.map((c) => ({ id: c.id, text: c.text, label: passageLabel(c) }))} />
    </section>
  );
}

function passageLabel(c: Chunk): string {
  if (c.locator.page !== undefined) return `Page ${c.locator.page}`;
  if (c.locator.timeStartSec !== undefined) return `From ${formatTime(c.locator.timeStartSec)}`;
  return `Passage ${c.idx + 1}`;
}

/* ── What the brain learned ───────────────────────────────────────────────────────────────────────────────── */

function Learned({ d, busy, stuck, reminders, label }: { d: Detail; busy: boolean; stuck: boolean; reminders: ReminderDTO[]; label: (k: string) => string }) {
  const s = d.source;
  const note = s.status === "ready" ? extractionNote(s.extraction) : null;
  const people = d.entities.filter((e) => e.type === "person");
  const events = d.entities.filter((e) => e.type === "event").sort((a, b) => (a.startAt ?? "9").localeCompare(b.startAt ?? "9"));
  const things = d.entities.filter((e) => e.type !== "person" && e.type !== "event");
  const nothing = people.length + events.length + things.length + d.facts.length + reminders.length === 0;
  const chunkIdx = new Map(d.chunks.map((c) => [c.id, c.idx]));

  return (
    <section aria-labelledby="learned-h">
      <h2 id="learned-h" className="scroll-mt-20 text-lg font-semibold tracking-[-0.01em]">Found in this file</h2>

      {/* Honest state first: is the reading done, and did it work? */}
      {busy && (
        <div role="status" className="mt-3 flex gap-2.5 rounded-lg bg-accent-tint px-4 py-3 text-sm text-accent">
          <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
          <p>{s.status === "pending" ? "Waiting its turn to be read." : "Reading it now for people, places and dates."} This page fills in by itself.</p>
        </div>
      )}
      {stuck && (
        <div role="status" className="mt-3 flex gap-2.5 rounded-lg bg-warn-tint px-4 py-3 text-sm text-warn">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>Reading started a long time ago and seems to have stopped, probably at a restart.{s.isOwner ? " Use Read again below." : ""}</p>
        </div>
      )}
      {s.status === "failed" && (
        <div role="alert" className="mt-3 flex gap-2.5 rounded-lg bg-danger-tint px-4 py-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          <div>
            <p className="font-medium text-danger">This file couldn&apos;t be read</p>
            <p className="mt-0.5 text-fg/80">{s.error ?? "Something went wrong while reading it."}{s.isOwner ? " The original is safe. Use Read again below to retry." : ""}</p>
          </div>
        </div>
      )}
      {(note || s.warnings.length > 0) && (
        <div className="mt-3 rounded-lg bg-warn-tint px-4 py-3 text-sm text-warn">
          <ul className="space-y-1">
            {note && <li>{note}</li>}
            {s.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      {nothing ? (
        !busy && s.status === "ready" && !note && (
          <p className="mt-3 text-sm text-muted">Nobody and nothing in it was stated plainly enough to add to the family&apos;s graph.</p>
        )
      ) : (
        <div className="mt-5 space-y-7">
          {people.length > 0 && (
            <Group title="People" count={people.length}>
              <ul className="flex flex-wrap gap-1.5">
                {people.map((p) => <li key={p.id}><PersonChip id={p.id} name={p.label} href={`/node/${p.id}`} /></li>)}
              </ul>
            </Group>
          )}

          {events.length > 0 && (
            <Group title="Dates" count={events.length}>
              <ul>
                {events.map((e) => (
                  <li key={e.id} className="flex gap-4 py-1.5">
                    <span className="w-[5.5rem] shrink-0 text-sm">
                      {e.startAt ? <><span className="font-medium">{formatDay(e.startAt)}</span>{hasTime(e.startAt) && <span className="block text-xs text-muted">{format(new Date(e.startAt), "HH:mm")}</span>}</>
                        : <span className="text-muted">No date</span>}
                    </span>
                    <span className="min-w-0 text-sm">
                      <Link href={`/node/${e.id}`} className="font-medium hover:underline">{e.label}</Link>
                      {e.summary && <span className="mt-0.5 block text-xs text-muted">{e.summary}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {reminders.length > 0 && (
            <Group title="Reminders made from it" count={reminders.length}>
              <ul>
                {reminders.map((r) => (
                  <li key={r.id} className="flex gap-2.5 py-1.5 text-sm">
                    {r.done ? <CircleCheck aria-label="Done" className="mt-0.5 size-4 shrink-0 text-muted" /> : <Bell aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />}
                    <span className="min-w-0">
                      <span className={r.done ? "text-muted line-through" : "font-medium"}>{r.title}</span>
                      <span className="block text-xs text-muted">
                        {r.done ? "Done" : `Due ${formatDay(r.dueAt)}`}{r.aboutLabel ? `, about ${r.aboutLabel}` : ""}
                        {r.createdByKind === "assistant" && <span className="text-inferred"> (suggested by the assistant)</span>}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {things.length > 0 && (
            <Group title="Places and topics" count={things.length}>
              <ul className="flex flex-wrap gap-1.5">
                {things.map((e) => <li key={e.id}><NodeChip type={e.type} label={e.label} href={`/node/${e.id}`} /></li>)}
              </ul>
            </Group>
          )}

          {d.facts.length > 0 && (
            <Group title="How it all connects" count={d.facts.length}
              hint="Press a citation to see the words it was read from.">
              <ul>
                {d.facts.map((f) => <FactRow key={f.edgeId} f={f} relation={label(f.relation)} passage={f.chunkId ? chunkIdx.get(f.chunkId) : undefined} />)}
              </ul>
            </Group>
          )}
        </div>
      )}
    </section>
  );
}

const hasTime = (iso: string) => { const t = format(new Date(iso), "HH:mm"); return t !== "00:00" && t !== "23:59"; };

function Group({ title, count, hint, children }: { title: string; count: number; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
        {title}<span className="font-normal tabular-nums text-muted">{count}</span>
      </h3>
      {hint && <p className="-mt-1 mb-2 text-xs text-muted">{hint}</p>}
      {children}
    </div>
  );
}

function Name({ n }: { n: ExtractedFact["from"] }) {
  if (n.type === "person") return <PersonChip id={n.id} name={n.label} href={`/node/${n.id}`} className="align-middle" />;
  return <Link href={`/node/${n.id}`} className="font-medium hover:underline">{n.label}</Link>;
}

function citeTitle(f: ExtractedFact, passage: number | undefined): string {
  if (f.locator.page !== undefined) return `Page ${f.locator.page}`;
  if (f.locator.timeStartSec !== undefined) return `At ${formatTime(f.locator.timeStartSec)}`;
  if (passage !== undefined) return `Passage ${passage + 1}`;
  return "In the text";
}

function FactRow({ f, relation, passage }: { f: ExtractedFact; relation: string; passage?: number }) {
  return (
    <li className="border-b border-line py-3 first:pt-1 last:border-0">
      <p className="text-sm leading-7">
        <Name n={f.from} /> <span className="text-muted">{relation}</span> <Name n={f.to} />
      </p>
      {f.quote && <p className="mt-0.5 text-sm text-muted">&ldquo;{f.quote}&rdquo;</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <CiteButton title={citeTitle(f, passage)} confidence={f.confidence}
          target={{ key: f.edgeId, quote: f.quote, chunkId: f.chunkId, page: f.locator.page, time: f.locator.timeStartSec, charStart: f.locator.charStart, charEnd: f.locator.charEnd }} />
        {f.status === "inferred" && <span className="text-xs text-inferred">Inferred, not confirmed</span>}
        {f.status === "unconfirmed" && <span className="text-xs text-warn">Needs checking</span>}
        {f.status !== "inferred" && f.status !== "unconfirmed" && f.status !== "confirmed" && <span className="text-xs text-muted">{f.status}</span>}
      </div>
    </li>
  );
}
