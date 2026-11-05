import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, ArrowLeft, Bell, CalendarDays, CircleCheck, ExternalLink, GitPullRequestArrow, History, LoaderCircle, Lock, MapPin, MessagesSquare, Paperclip, ShieldAlert, Users, UsersRound } from "lucide-react";
import { NodeChip, PersonChip } from "@/components/ui";
import { AudioTranscript } from "@/components/library/audio-transcript";
import { RecordingSection } from "@/components/recording/recording-section";
import { CiteButton, MarkedText, PassageList, PdfFrame, ProvenanceProvider } from "@/components/library/provenance";
import { SharingSettings, SourceSettings } from "@/components/library/source-settings";
import { isStuck, StatusPill, stepText } from "@/components/library/source-meta";
import { countsLine, dateOriginNote, extractionNote, formatBytes, formatDay, formatDocDate, formatMoment, kindWord, listJoin, senderName, timeOfDay, visibilityLabel, type Lx } from "@/components/library/i18n";
import { libraryLx } from "@/components/library/server-lx";
import { StatusWatcher } from "@/components/library/status-watcher";
import { requireUser, type Viewer } from "@/lib/auth";
import { getChangeSet } from "@/lib/changes";
import { ChangeSetCard } from "@/components/changes";
import { listReminders, type ReminderDTO } from "@/lib/briefs";
import { formatTime } from "@/lib/ingest/chunk";
import { getSourceDetail, type ExtractedFact, type SourceDetail } from "@/lib/ingest/library";
import { getT } from "@/lib/i18n";
import { getMeta } from "@/lib/meta";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("library.fileMetaTitle") };
}

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
  // An upload that was the same as a file already here wasn't kept: show the file it was the same as.
  if (d.source.duplicateOf) redirect(`/library/${d.source.duplicateOf.id}`);
  const pendingId = d.proposal?.changeSetId && d.proposal.status !== "delivered" && d.proposal.status !== "abandoned" ? d.proposal.changeSetId : null;
  const [label, reminders, L, pendingSet] = await Promise.all([relationLabeller(v), remindersFrom(v, id), libraryLx(v),
    pendingId ? getChangeSet(v, pendingId).catch(() => null) : Promise.resolve(null)]);
  const { t } = L;
  const s = d.source;
  const stuck = isStuck(s.status, s.startedAt, s.createdAt, s.job);
  const busy = !!s.job || ((s.status === "pending" || s.status === "processing") && !stuck);
  const VisIcon = s.visibility === "private" ? Lock : s.visibility === "parents" ? UsersRound : Users;
  const family = L.family;
  const dateFrom = (s.meta.documentDateFrom ?? null) as { origin?: string; quote?: string | null } | null;
  const who = s.isOwner ? t("library.detail.byYou") : s.ownerName ?? t(family ? "library.detail.bySomeoneFamily" : "library.detail.bySomeone");
  const whom = s.visibility === "household" ? t(family ? "library.detail.whom.householdFamily" : "library.detail.whom.household")
    : s.visibility === "parents" ? t(family ? "library.detail.whom.parentsFamily" : "library.detail.whom.parents") : t("library.detail.whom.private");

  return (
    <ProvenanceProvider>
      <StatusWatcher active={busy} />
      <Link href="/library" className="mb-5 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />{t("library.detail.back")}
      </Link>

      <header className="mb-8">
        <h1 className="break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{s.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          {s.documentDate && (
            <span className="inline-flex items-center gap-1.5 font-medium text-fg" title={dateOriginNote(L, dateFrom)}>
              <CalendarDays aria-hidden className="size-4 text-muted" />{t("library.detail.dated", { date: formatDocDate(L, s.documentDate, s.documentDatePrecision) })}
            </span>
          )}
          <span>
            {t("library.detail.addedBy", { kind: kindWord(L, s.docKind, s.category), when: formatMoment(L, s.createdAt), who })}
            {s.size ? `, ${formatBytes(L, s.size)}` : ""}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg">
            <VisIcon aria-hidden className="size-3.5 text-muted" />{visibilityLabel(L, s.visibility)}
          </span>
          {s.sensitive && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warn-tint px-2 py-0.5 text-xs font-medium text-warn">
              <ShieldAlert aria-hidden className="size-3.5" />{t("library.detail.sensitive")}
            </span>
          )}
          {d.versions.length > 1 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg">
              <History aria-hidden className="size-3.5 text-muted" />{t("library.versions.badge", { n: s.revision, count: d.versions.length })}
            </span>
          )}
          <StatusPill L={L} status={s.status} stuck={stuck} job={s.job} />
          {s.job?.status === "running" && <span className="text-accent">{stepText(L, s.job.progress)}</span>}
        </div>
      </header>

      {s.superseded && (() => {
        const newest = d.versions.find((x) => x.current);
        return newest ? (
          <p role="note" className="-mt-4 mb-8 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">
            {t("library.versions.older", { n: s.revision })}{" "}
            <Link href={`/library/${newest.id}`} className="font-medium underline">{t("library.versions.openNewest", { n: newest.revision })}</Link>
          </p>
        ) : null;
      })()}
      <FoundSummary L={L} d={d} reminders={reminders.length} />
      <Proposed L={L} d={d} />
      {pendingSet?.status === "draft" && <div className="-mt-2 mb-8"><ChangeSetCard cs={pendingSet} t={t} locale={L.locale} compact actions /></div>}

      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-8">
          {s.meta.kind === "recording" ? <RecordingSection viewer={v} sourceId={s.id} /> : <Original L={L} d={d} />}
          <ReadText L={L} d={d} />
          <ImportedMessages L={L} d={d} />
        </div>

        <aside className="min-w-0 space-y-10" aria-label={t("library.detail.foundAside")}>
          <Conversation L={L} d={d} />
          <Versions L={L} d={d} />
          {s.category !== "mailbox" && <Learned L={L} d={d} busy={busy} stuck={stuck} reminders={reminders} label={label} />}

          <section aria-labelledby="sharing-h">
            <h2 id="sharing-h" className="mb-4 text-lg font-semibold tracking-[-0.01em]">{t("library.detail.sharing")}</h2>
            {s.isOwner ? (
              <SharingSettings family={family} id={s.id} visibility={s.visibility} sensitive={s.sensitive} />
            ) : (
              <p className="text-sm text-muted">
                {t("library.detail.sharedWith", { owner: s.ownerName ?? t("library.list.someone"), whom })}
              </p>
            )}
          </section>

          {s.isOwner && (
            <section aria-labelledby="file-h">
              <h2 id="file-h" className="mb-4 text-lg font-semibold tracking-[-0.01em]">{t("library.detail.theFile")}</h2>
              <SourceSettings family={family} id={s.id} title={s.title} visibility={s.visibility} sensitive={s.sensitive} hasFile={s.hasFile} busy={busy} />
            </section>
          )}
        </aside>
      </div>
    </ProvenanceProvider>
  );
}

/** What reading the file proposed for the graph: nothing is added until someone delivers it. */
function Proposed({ L, d }: { L: Lx; d: Detail }) {
  const { t } = L;
  const p = d.proposal;
  if (!p || p.total === 0) return null;
  const what = countsLine(L, p.counts);
  if (p.status === "waiting" || !p.changeSetId) {
    return (
      <div className="-mt-4 mb-6 flex items-start gap-2.5 rounded-lg bg-warn-tint px-4 py-3 text-sm text-warn">
        <GitPullRequestArrow aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>{t("library.detail.proposal.waiting", { count: p.total, what })}</p>
      </div>
    );
  }
  const decided = p.status === "delivered" ? t("library.detail.proposal.delivered", { what }) : p.status === "abandoned" ? t("library.detail.proposal.abandoned", { what }) : null;
  return (
    <Link href={`/changes/${p.changeSetId}`}
      className={`-mt-4 mb-6 flex items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm ${decided ? "bg-surface-2 text-muted" : "bg-warn-tint text-warn"}`}>
      <span className="inline-flex items-start gap-2.5">
        <GitPullRequestArrow aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-medium">{t("library.detail.proposal.title", { count: p.total })}</span>
          <span className="block text-fg/70">{decided ?? t("library.detail.proposal.open", { what: `${what[0].toUpperCase()}${what.slice(1)}` })}</span>
        </span>
      </span>
      <span aria-hidden className="shrink-0 font-medium">{decided ? t("library.detail.proposal.see") : t("library.detail.proposal.review")}</span>
    </Link>
  );
}

/** Every version of this document, newest first, this one marked; and other names the same file came under. */
function Versions({ L, d }: { L: Lx; d: Detail }) {
  const { t } = L;
  const s = d.source;
  if (d.versions.length < 2 && !s.otherNames.length) return null;
  return (
    <section aria-labelledby="versions-h">
      {d.versions.length > 1 && (
        <>
          <h2 id="versions-h" className="mb-3 text-lg font-semibold tracking-[-0.01em]">{t("library.versions.title")}</h2>
          <ol className="space-y-0.5">
            {d.versions.map((x) => {
              const here = x.id === s.id;
              return (
                <li key={x.id}>
                  <Link href={`/library/${x.id}`} aria-current={here ? "page" : undefined}
                    className={`flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm ${here ? "bg-surface font-medium" : "hover:bg-surface-2"}`}>
                    <span className="w-[4.5rem] shrink-0 tabular-nums text-muted">{t("library.versions.n", { n: x.revision })}</span>
                    <span className="min-w-0 flex-1 truncate">{x.title}</span>
                    <span className="shrink-0 text-muted">{x.current ? t("library.versions.newest") : formatDay(L, x.createdAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-sm text-muted">{t("library.versions.how")}</p>
        </>
      )}
      {s.otherNames.length > 0 && (
        <p className={`text-sm text-muted ${d.versions.length > 1 ? "mt-4" : ""}`}>
          {t("library.versions.otherNames", { names: listJoin(L, s.otherNames.map((n) => (L.locale === "da" ? `„${n}“` : `“${n}”`))) })}
        </p>
      )}
    </section>
  );
}

/** Mail: the rest of the conversation, oldest first, this message marked. Attachments and the email they came with. */
function Conversation({ L, d }: { L: Lx; d: Detail }) {
  const { t } = L;
  const s = d.source;
  if (!d.thread && !d.attachments.length && !d.parent) return null;
  return (
    <section aria-labelledby="conv-h" className="space-y-5">
      {d.thread && (
        <div>
          <h2 id="conv-h" className="mb-3 flex items-baseline gap-2 text-lg font-semibold tracking-[-0.01em]">
            {t("library.detail.conversation")}<span className="text-sm font-normal tabular-nums text-muted">{t("library.count.messages", { count: d.thread.messages.length })}</span>
          </h2>
          <ol className="space-y-0.5">
            {d.thread.messages.map((m) => {
              const here = m.id === s.id;
              const from = senderName(m.from) ?? t("library.list.someone");
              return (
                <li key={m.id}>
                  <Link href={`/library/${m.id}`} aria-current={here ? "page" : undefined}
                    className={`flex gap-3 rounded-md px-2 py-1.5 text-sm ${here ? "bg-surface font-medium" : "hover:bg-surface-2"}`}>
                    <span className="w-[5.5rem] shrink-0 text-muted">{formatDay(L, m.at)}</span>
                    <span className="min-w-0 truncate">{from}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
          <Link href={`/library/thread?key=${encodeURIComponent(d.thread.key)}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            <MessagesSquare aria-hidden className="size-4" />{t("library.detail.readWhole")}
          </Link>
        </div>
      )}
      {d.parent && (
        <p className="text-sm text-muted">
          {t("library.detail.attachedTo")} <Link href={`/library/${d.parent.id}`} className="font-medium text-accent hover:underline">{d.parent.title}</Link>.
        </p>
      )}
      {d.attachments.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("library.detail.attachments")}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {d.attachments.map((a) => (
              <li key={a.id}><Link href={`/library/${a.id}`} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-sm hover:bg-line"><Paperclip aria-hidden className="size-3.5" />{a.title}</Link></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A mail import: the messages it brought in. */
function ImportedMessages({ L, d }: { L: Lx; d: Detail }) {
  const { t } = L;
  const s = d.source;
  if (s.messages === null) return null;
  const dup = typeof s.meta.duplicates === "number" ? s.meta.duplicates : 0;
  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold tracking-[-0.01em]">{t("library.detail.importTitle")}</h2>
      <p className="mb-4 text-sm text-muted">
        {t(dup ? "library.detail.importLineDup" : "library.detail.importLine", { imported: s.imported ?? 0, total: s.messages, dup })}
      </p>
      {d.importedMessages.length > 0 && (
        <ul>
          {d.importedMessages.map((m) => (
            <li key={m.id} className="flex gap-4 border-b border-line py-2 text-sm last:border-0">
              <span className="w-28 shrink-0 text-muted">{m.at ? formatDay(L, m.at) : t("library.detail.noDate")}</span>
              <Link href={`/library/${m.id}`} className="min-w-0 truncate hover:underline">{m.title}</Link>
            </li>
          ))}
        </ul>
      )}
      <Link href="/library?type=mail" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">{t("library.detail.allMail")}</Link>
    </section>
  );
}

/** Phones: the findings sit below the original, so say up front what is there and link to it. */
function FoundSummary({ L, d, reminders }: { L: Lx; d: Detail; reminders: number }) {
  const { t } = L;
  const people = d.entities.filter((e) => e.type === "person").length;
  const dates = d.entities.filter((e) => e.type === "event").length;
  const parts = [
    people && t("library.count.people", { count: people }),
    dates && t("library.count.dates", { count: dates }),
    reminders && t("library.count.reminders", { count: reminders }),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  const list = listJoin(L, parts);
  return (
    <a href="#learned-h" className="-mt-4 mb-6 flex items-center justify-between gap-3 rounded-lg bg-accent-tint px-4 py-3 text-sm text-accent lg:hidden">
      <span>{t("library.detail.found", { list })}</span><span aria-hidden className="shrink-0 whitespace-nowrap">{t("library.detail.seeThem")}</span>
    </a>
  );
}

/* ── The original ─────────────────────────────────────────────────────────────────────────────────────────── */

function Original({ L, d }: { L: Lx; d: Detail }) {
  const { t } = L;
  const s = d.source;
  if (s.category === "mailbox") return null; // a mail import is its messages (ImportedMessages)
  const url = `/api/files/${s.id}`;
  const exif = (s.meta.exif ?? null) as { takenAt: string | null; lat: number | null; lon: number | null; camera: string | null } | null;
  const email = (s.meta.email ?? null) as { subject: string | null; from: string | null; date: string | null } | null;
  const caption = typeof s.meta.captionText === "string" ? s.meta.captionText : null;

  if (s.category === "image") {
    const details: [string, React.ReactNode][] = [];
    // The description is also the photo's first passage; show it once, where citations can point at it.
    if (caption && d.chunks.length === 0) details.push([t("library.detail.photo.whatsIn"), caption]);
    if (exif?.takenAt) details.push([t("library.detail.photo.taken"), formatMoment(L, exif.takenAt)]);
    if (exif?.lat != null && exif?.lon != null) {
      details.push([t("library.detail.photo.where"), (
        <a key="map" className="inline-flex items-center gap-1 text-accent hover:underline" target="_blank" rel="noreferrer noopener"
          href={`https://www.openstreetmap.org/?mlat=${exif.lat}&mlon=${exif.lon}#map=16/${exif.lat}/${exif.lon}`}>
          <MapPin aria-hidden className="size-3.5" />{t("library.detail.photo.map")}
        </a>
      )]);
    }
    if (exif?.camera) details.push([t("library.detail.photo.camera"), exif.camera]);
    return (
      <section aria-label={t("library.detail.photo.aria")}>
        {s.mime === "image/heic" ? (
          <div className="rounded-lg bg-surface p-8 text-sm text-muted">
            {t("library.detail.heic")} <a className="text-accent hover:underline" href={`${url}?download=1`}>{t("library.detail.heicDownload")}</a> {t("library.detail.heicTail")}
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
      <section aria-label={t("library.detail.pdfAria")}>
        <div className="overflow-hidden rounded-lg bg-surface">
          <PdfFrame url={url} title={s.title} />
        </div>
        <a className="mt-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg" href={url} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden className="size-3.5" />{t("library.detail.pdfOpen")}
        </a>
      </section>
    );
  }

  if (s.category === "audio") {
    return (
      <section aria-label={t("library.detail.audioAria")} className="overflow-hidden rounded-lg bg-surface">
        <AudioTranscript src={url} title={s.title}
          segments={d.chunks.map((c) => ({ id: c.id, text: c.text, start: c.locator.timeStartSec ?? null, end: c.locator.timeEndSec ?? null }))} />
      </section>
    );
  }

  // Letters, notes, Word documents and emails: the text itself, on a page.
  const text = s.textContent ?? "";
  const emailRows: [string, React.ReactNode][] = [];
  if (email?.subject) emailRows.push([t("library.detail.email.subject"), email.subject]);
  if (email?.from) emailRows.push([t("library.detail.email.from"), email.from]);
  if (email?.date) emailRows.push([t("library.detail.email.sent"), formatMoment(L, email.date)]);
  // Pasted text and saved web pages: the page it came from.
  const pageUrl = typeof s.meta.url === "string" && /^https?:\/\//i.test(s.meta.url) ? s.meta.url : null;
  if (pageUrl) {
    emailRows.push([t("library.detail.webFrom"), (
      <a key="page" href={pageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-accent hover:underline">
        <ExternalLink aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{pageUrl.replace(/^https?:\/\/(www\.)?/i, "")}</span>
      </a>
    )]);
  }
  return (
    <section aria-label={t("library.detail.textAria")} className="rounded-lg bg-surface px-5 py-6 sm:px-10 sm:py-9">
      {emailRows.length > 0 && <div className="mb-6 border-b border-line pb-4"><Details rows={emailRows} flush /></div>}
      {text.trim() ? (
        <div className="max-h-[78vh] overflow-y-auto">
          <MarkedText rangeFromLocator text={text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text}
            className="max-w-[68ch] whitespace-pre-wrap break-words text-[15px] leading-7" />
        </div>
      ) : (
        <p className="text-sm text-muted">{s.status === "ready" ? t("library.detail.noText") : t("library.detail.textLater")}</p>
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
function ReadText({ L, d }: { L: Lx; d: Detail }) {
  const { t } = L;
  const s = d.source;
  if (s.category !== "pdf" && s.category !== "image") return null;
  if (d.chunks.length === 0) {
    if (s.category === "image") return null;
    return (
      <section>
        <h2 className="mb-2 text-lg font-semibold tracking-[-0.01em]">{t("library.detail.pdfText")}</h2>
        <p className="text-sm text-muted">{s.status === "ready" ? t("library.detail.pdfNoText") : t("library.detail.textLater")}</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold tracking-[-0.01em]">{s.category === "pdf" ? t("library.detail.pdfText") : t("library.detail.photoText")}</h2>
      <PassageList chunks={d.chunks.map((c) => ({ id: c.id, text: c.text, label: passageLabel(L, c) }))} />
    </section>
  );
}

function passageLabel(L: Lx, c: Chunk): string {
  if (c.locator.page !== undefined) return L.t("library.detail.page", { n: c.locator.page });
  if (c.locator.timeStartSec !== undefined) return L.t("library.detail.fromTime", { time: formatTime(c.locator.timeStartSec) });
  return L.t("library.detail.passage", { n: c.idx + 1 });
}

/* ── What reading the file found ───────────────────────────────────────────────────────────────────────────────── */

function Learned({ L, d, busy, stuck, reminders, label }: { L: Lx; d: Detail; busy: boolean; stuck: boolean; reminders: ReminderDTO[]; label: (k: string) => string }) {
  const { t, family } = L;
  const s = d.source;
  const note = s.status === "ready" ? extractionNote(L, s.extraction) : null;
  const people = d.entities.filter((e) => e.type === "person");
  const events = d.entities.filter((e) => e.type === "event").sort((a, b) => (a.startAt ?? "9").localeCompare(b.startAt ?? "9"));
  const things = d.entities.filter((e) => e.type !== "person" && e.type !== "event");
  const nothing = people.length + events.length + things.length + d.facts.length + reminders.length === 0;
  const chunkIdx = new Map(d.chunks.map((c) => [c.id, c.idx]));

  return (
    <section aria-labelledby="learned-h">
      <h2 id="learned-h" className="scroll-mt-20 text-lg font-semibold tracking-[-0.01em]">{t("library.detail.learned")}</h2>

      {/* Honest state first: is the reading done, and did it work? */}
      {busy && (
        <div role="status" className="mt-3 flex gap-2.5 rounded-lg bg-accent-tint px-4 py-3 text-sm text-accent">
          <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
          <p>{s.status === "pending" ? t("library.detail.pending") : t("library.detail.processing")} {t("library.detail.fillsIn")}</p>
        </div>
      )}
      {stuck && (
        <div role="status" className="mt-3 flex gap-2.5 rounded-lg bg-warn-tint px-4 py-3 text-sm text-warn">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{t("library.detail.stuck")}{s.isOwner ? ` ${t("library.detail.stuckOwner")}` : ""}</p>
        </div>
      )}
      {s.status === "failed" && (
        <div role="alert" className="mt-3 flex gap-2.5 rounded-lg bg-danger-tint px-4 py-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          <div>
            <p className="font-medium text-danger">{t("library.detail.failedTitle")}</p>
            <p className="mt-0.5 text-fg/80">{s.error ?? t("library.detail.failedBody")}{s.isOwner ? ` ${t("library.detail.failedOwner")}` : ""}</p>
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
          <p className="mt-3 text-sm text-muted">
            {d.proposal && d.proposal.total > 0
              ? t("library.detail.waitingInProposal")
              : t(family ? "library.detail.nothingFamily" : "library.detail.nothing")}
          </p>
        )
      ) : (
        <div className="mt-5 space-y-7">
          {people.length > 0 && (
            <Group title={t("library.detail.people")} count={people.length}>
              <ul className="flex flex-wrap gap-1.5">
                {people.map((p) => <li key={p.id}><PersonChip id={p.id} name={p.label} href={`/node/${p.id}`} /></li>)}
              </ul>
            </Group>
          )}

          {events.length > 0 && (
            <Group title={t("library.detail.dates")} count={events.length}>
              <ul>
                {events.map((e) => (
                  <li key={e.id} className="flex gap-4 py-1.5">
                    <span className="w-[5.5rem] shrink-0 text-sm">
                      {e.startAt ? <><span className="font-medium">{formatDay(L, e.startAt)}</span>{timeOfDay(L, e.startAt) && <span className="block text-xs text-muted">{timeOfDay(L, e.startAt)}</span>}</>
                        : <span className="text-muted">{t("library.detail.noDate")}</span>}
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
            <Group title={t("library.detail.reminders")} count={reminders.length}>
              <ul>
                {reminders.map((r) => (
                  <li key={r.id} className="flex gap-2.5 py-1.5 text-sm">
                    {r.done ? <CircleCheck aria-label={t("library.detail.done")} className="mt-0.5 size-4 shrink-0 text-muted" /> : <Bell aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />}
                    <span className="min-w-0">
                      <span className={r.done ? "text-muted line-through" : "font-medium"}>{r.title}</span>
                      <span className="block text-xs text-muted">
                        {r.done ? t("library.detail.done") : t("library.detail.due", { day: formatDay(L, r.dueAt) })}{r.aboutLabel ? t("library.detail.about", { label: r.aboutLabel }) : ""}
                        {r.createdByKind === "assistant" && <span className="text-inferred">{t("library.detail.suggested")}</span>}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {things.length > 0 && (
            <Group title={t(family ? "library.detail.things" : "library.detail.thingsGraph")} count={things.length}>
              <ul className="flex flex-wrap gap-1.5">
                {things.map((e) => <li key={e.id}><NodeChip type={e.type} label={e.label} href={`/node/${e.id}`} /></li>)}
              </ul>
            </Group>
          )}

          {d.facts.length > 0 && (
            <Group title={t("library.detail.connects")} count={d.facts.length}
              hint={t("library.detail.connectsHint")}>
              <ul>
                {d.facts.map((f) => <FactRow L={L} key={f.edgeId} f={f} relation={label(f.relation)} passage={f.chunkId ? chunkIdx.get(f.chunkId) : undefined} />)}
              </ul>
            </Group>
          )}
        </div>
      )}
    </section>
  );
}

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

function citeTitle(L: Lx, f: ExtractedFact, passage: number | undefined): string {
  if (f.locator.page !== undefined) return L.t("library.detail.page", { n: f.locator.page });
  if (f.locator.timeStartSec !== undefined) return L.t("library.detail.atTime", { time: formatTime(f.locator.timeStartSec) });
  if (passage !== undefined) return L.t("library.detail.passage", { n: passage + 1 });
  return L.t("library.detail.inText");
}

function FactRow({ L, f, relation, passage }: { L: Lx; f: ExtractedFact; relation: string; passage?: number }) {
  const { t } = L;
  return (
    <li className="border-b border-line py-3 first:pt-1 last:border-0">
      <p className="text-sm leading-7">
        <Name n={f.from} /> <span className="text-muted">{relation}</span> <Name n={f.to} />
      </p>
      {f.quote && <p className="mt-0.5 text-sm text-muted">&ldquo;{f.quote}&rdquo;</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <CiteButton title={citeTitle(L, f, passage)} confidence={f.confidence}
          target={{ key: f.edgeId, quote: f.quote, chunkId: f.chunkId, page: f.locator.page, time: f.locator.timeStartSec, charStart: f.locator.charStart, charEnd: f.locator.charEnd }} />
        {f.status === "inferred" && <span className="text-xs text-inferred">{t("library.detail.inferred")}</span>}
        {f.status === "unconfirmed" && <span className="text-xs text-warn">{t("library.detail.unconfirmed")}</span>}
        {f.status !== "inferred" && f.status !== "unconfirmed" && f.status !== "confirmed" && <span className="text-xs text-muted">{t(`library.detail.factStatus.${f.status}`, undefined, f.status)}</span>}
      </div>
    </li>
  );
}
