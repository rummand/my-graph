import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, ArrowLeft, Info, MapPin } from "lucide-react";
import { Card, CitationChip, EmptyState, NodeChip } from "@/components/ui";
import { AudioTranscript } from "@/components/library/audio-transcript";
import { SourceSettings } from "@/components/library/source-settings";
import { extractionNote, formatBytes, isStuck, StatusPill, TypeIcon, visibilityLabel } from "@/components/library/source-meta";
import { StatusWatcher } from "@/components/library/status-watcher";
import { requireUser } from "@/lib/auth";
import { formatLocator } from "@/lib/ingest/chunk";
import { getSourceDetail, type SourceDetail } from "@/lib/ingest/library";
import { CATEGORY_LABEL } from "@/lib/ingest/mime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "File · My Graph" };

const RELATION_LABEL: Record<string, string> = {
  parent_of: "is parent of", attends: "attends", treated_by: "is treated by", knows: "knows", located_at: "is at",
  happened_at: "happens at", involves: "involves", follows: "follows", caused_by: "is caused by", about: "is about",
  tagged_with: "is tagged", mentions: "mentions", derived_from: "comes from", version_of: "is a version of", supports: "supports",
};

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const v = await requireUser();
  const d = await getSourceDetail(v, id);
  if (!d) notFound();
  const s = d.source;
  const busy = (s.status === "pending" || s.status === "processing") && !isStuck(s.status, s.startedAt, s.createdAt);
  const note = s.status === "ready" ? extractionNote(s.extraction) : null;
  const exif = (s.meta.exif ?? null) as { takenAt: string | null; lat: number | null; lon: number | null; camera: string | null } | null;
  const email = (s.meta.email ?? null) as { subject: string | null; from: string | null; date: string | null } | null;
  const caption = typeof s.meta.captionText === "string" ? s.meta.captionText : null;

  return (
    <div className="mx-auto max-w-6xl">
      <StatusWatcher active={busy} />
      <Link href="/library" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />Library
      </Link>

      <header className="mb-6">
        <div className="flex items-start gap-3">
          <TypeIcon category={s.category} mime={s.mime} className="mt-1 size-6 text-muted" />
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-2xl font-semibold tracking-tight">{s.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span>{CATEGORY_LABEL[s.category]}</span>
              {s.size ? <span>· {formatBytes(s.size)}</span> : null}
              <span>· added {format(new Date(s.createdAt), "d MMM yyyy, HH:mm")}{!s.isOwner && s.ownerName ? ` by ${s.ownerName}` : ""}</span>
              <span>· {visibilityLabel(s.visibility)}{s.sensitive ? " · Sensitive" : ""}</span>
              <StatusPill status={s.status} stuck={isStuck(s.status, s.startedAt, s.createdAt)} />
            </p>
          </div>
        </div>
      </header>

      {s.status === "failed" && (
        <div role="alert" className="mb-6 flex gap-2 rounded-lg border border-line bg-surface p-4 text-sm">
          <AlertTriangle aria-hidden className="size-5 shrink-0 text-danger" />
          <div>
            <p className="font-medium text-danger">Reading this file failed</p>
            <p className="mt-1 text-muted">{s.error ?? "Unknown error."} {s.isOwner ? "Use “Read again” to retry." : ""}</p>
          </div>
        </div>
      )}
      {busy && (
        <div role="status" className="mb-6 rounded-lg border border-line bg-accent-tint p-4 text-sm text-accent">
          Reading the file and finding people, places and events. This page updates by itself.
        </div>
      )}
      {(note || s.warnings.length > 0) && (
        <div className="mb-6 flex gap-2 rounded-lg border border-line bg-surface p-4 text-sm">
          <Info aria-hidden className="size-5 shrink-0 text-warn" />
          <ul className="space-y-1 text-muted">
            {note && <li>{note}</li>}
            {s.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <h2 className="mb-3 text-base font-semibold">Preview</h2>
            <Preview d={d} />
            {(exif || email || caption) && (
              <dl className="mt-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                {caption && <><dt className="text-muted">Description</dt><dd>{caption}</dd></>}
                {exif?.takenAt && <><dt className="text-muted">Taken</dt><dd>{format(new Date(exif.takenAt), "d MMM yyyy, HH:mm")}</dd></>}
                {exif?.lat != null && exif?.lon != null && (
                  <><dt className="text-muted">Place</dt><dd>
                    <a className="inline-flex items-center gap-1 text-accent hover:underline" target="_blank" rel="noreferrer noopener"
                      href={`https://www.openstreetmap.org/?mlat=${exif.lat}&mlon=${exif.lon}#map=16/${exif.lat}/${exif.lon}`}>
                      <MapPin aria-hidden className="size-3.5" />{exif.lat.toFixed(4)}, {exif.lon.toFixed(4)}
                    </a>
                  </dd></>
                )}
                {exif?.camera && <><dt className="text-muted">Camera</dt><dd>{exif.camera}</dd></>}
                {email?.subject && <><dt className="text-muted">Subject</dt><dd>{email.subject}</dd></>}
                {email?.from && <><dt className="text-muted">From</dt><dd className="break-words">{email.from}</dd></>}
                {email?.date && <><dt className="text-muted">Sent</dt><dd>{format(new Date(email.date), "d MMM yyyy, HH:mm")}</dd></>}
              </dl>
            )}
          </Card>

          {s.category !== "audio" && (
            <Card>
              <h2 className="mb-3 text-base font-semibold">Text found in the file</h2>
              <ExtractedText d={d} />
            </Card>
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          {s.isOwner && (
            <Card>
              <h2 className="mb-3 text-base font-semibold">Settings</h2>
              <SourceSettings id={s.id} title={s.title} visibility={s.visibility} sensitive={s.sensitive} hasFile={!!s.mime} busy={busy} />
            </Card>
          )}
          <Card>
            <h2 className="mb-3 text-base font-semibold">Found in this file</h2>
            {d.entities.length === 0 ? (
              <p className="text-sm text-muted">{busy ? "Still reading…" : "No people, places, events or topics yet."}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {d.entities.map((e) => <li key={e.id}><NodeChip type={e.type} label={e.label} href={`/node/${e.id}`} /></li>)}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="mb-1 text-base font-semibold">Facts</h2>
            <p className="mb-3 text-xs text-muted">Read from the text by the assistant. Facts under 0.60 confidence wait for a person to confirm them.</p>
            <Facts d={d} busy={busy} />
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Preview({ d }: { d: SourceDetail }) {
  const s = d.source;
  const url = `/api/files/${s.id}`;
  if (s.category === "image") {
    if (s.mime === "image/heic") {
      return <p className="text-sm text-muted">Your browser may not show HEIC photos. <a className="text-accent hover:underline" href={`${url}?download=1`}>Download the original</a>.</p>;
    }
    // eslint-disable-next-line @next/next/no-img-element -- authenticated original
    return <img src={url} alt={typeof s.meta.captionText === "string" ? s.meta.captionText : s.title} className="max-h-[70vh] w-auto max-w-full rounded-md border border-line" />;
  }
  if (s.category === "pdf") {
    return (
      <div>
        <iframe src={url} title={`PDF: ${s.title}`} className="h-[70vh] w-full rounded-md border border-line bg-surface-2" />
        <p className="mt-2 text-xs text-muted">Can&apos;t see it? <a className="text-accent hover:underline" href={url} target="_blank" rel="noreferrer">Open the PDF in a new tab</a>.</p>
      </div>
    );
  }
  if (s.category === "audio") {
    return (
      <AudioTranscript src={url} title={s.title} segments={d.chunks.map((c) => ({ id: c.id, text: c.text, start: c.locator.timeStartSec ?? null, end: c.locator.timeEndSec ?? null }))} />
    );
  }
  const text = s.textContent ?? "";
  if (!text.trim()) return <p className="text-sm text-muted">No preview available.</p>;
  return <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 font-mono text-xs">{text.slice(0, 20_000)}{text.length > 20_000 ? "\n…" : ""}</pre>;
}

function ExtractedText({ d }: { d: SourceDetail }) {
  const s = d.source;
  if (!s.textContent?.trim()) {
    return <p className="text-sm text-muted">{s.status === "ready" ? "No text was found in this file." : "The text appears here once the file has been read."}</p>;
  }
  if (s.category === "pdf") {
    const pages = s.textContent.split("\n\f\n");
    return (
      <div className="space-y-2">
        {pages.map((p, i) => (
          <details key={i} id={`page-${i + 1}`} open={i < 2} className="scroll-mt-20 rounded-md border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Page {i + 1}{p.trim() ? "" : " (no text)"}</summary>
            {p.trim() && <p className="whitespace-pre-wrap break-words border-t border-line px-3 py-2 text-sm">{p}</p>}
          </details>
        ))}
      </div>
    );
  }
  return (
    <ol className="space-y-3">
      {d.chunks.map((c) => (
        <li key={c.id} id={`chunk-${c.id}`} className="scroll-mt-20">
          <p className="mb-1 font-mono text-[11px] text-muted">Passage {c.idx + 1}{formatLocator(c.locator) ? ` · ${formatLocator(c.locator)}` : ""}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{c.text}</p>
        </li>
      ))}
    </ol>
  );
}

function Facts({ d, busy }: { d: SourceDetail; busy: boolean }) {
  if (d.facts.length === 0) {
    return <EmptyState title={busy ? "Still reading…" : "No facts yet"}>{!busy && <p>Nothing was stated plainly enough to add as a fact.</p>}</EmptyState>;
  }
  const isPdf = d.source.category === "pdf";
  return (
    <ul className="space-y-3">
      {d.facts.map((f) => {
        const loc = formatLocator(f.locator);
        const anchor = isPdf && f.locator.page ? `#page-${f.locator.page}` : f.chunkId ? `#chunk-${f.chunkId}` : undefined;
        return (
          <li key={f.edgeId} className="rounded-md border border-line p-3 text-sm">
            <p className="flex flex-wrap items-center gap-1.5">
              <NodeChip type={f.from.type} label={f.from.label} href={`/node/${f.from.id}`} />
              <span className="text-muted">{RELATION_LABEL[f.relation] ?? f.relation.replace(/_/g, " ")}</span>
              <NodeChip type={f.to.type} label={f.to.label} href={`/node/${f.to.id}`} />
            </p>
            {f.quote && <blockquote className="mt-2 border-l-2 border-line pl-2 text-muted">“{f.quote}”</blockquote>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CitationChip title={loc || "this file"} confidence={f.confidence} href={anchor} />
              {f.status !== "confirmed" && <span className="text-xs text-warn">{f.status === "unconfirmed" ? "Needs checking" : f.status}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
