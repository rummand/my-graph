"use client";
/**
 * One session or consultation: risk mentions first, then the draft note to read, correct and sign, beside the
 * recording and transcript; under it the suggestions to confirm or dismiss. Polls while transcription runs.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft, PenLine, RefreshCw } from "lucide-react";
import { Badge, Button, Field, PageHeader, Section, Textarea } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { NOTE_SECTIONS } from "@/lib/clinical/pure";
import type { SessionPageData } from "@/lib/clinical/views";
import type { ItemView } from "@/lib/clinical/items";
import { call } from "./api";
import { Suggestions } from "./client-record";
import { ItemCard, fmtTime, useDecide } from "./item-card";
import { Recorder } from "./recorder";

export function SessionView({ initial }: { initial: SessionPageData }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const [data, setData] = useState(initial);
  useEffect(() => setData(initial), [initial]);
  const running = data.session.work === "running";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      const r = await call<SessionPageData>(`/api/clinical/sessions/${data.session.id}`);
      if (r.data) {
        setData(r.data);
        if (r.data.session.work !== "running") router.refresh();
      }
    }, 3000);
    return () => clearInterval(id);
  }, [running, data.session.id, router]);

  const s = data.session, c = data.client, mine = c.access === "clinician";
  const items = data.items;
  const risks = items.filter((i) => i.kind === "risk" && i.status === "open");
  const note = items.find((i) => i.kind === "note" && i.status === "proposed") ?? null;
  const signed = items.find((i) => i.kind === "note" && i.status === "signed") ?? null;
  const suggestions = items.filter((i) => ["theme", "hypothesis", "code", "medication", "allergy", "followup"].includes(i.kind) && i.status !== "dismissed");
  const kickoff = () => setData((d) => ({ ...d, session: { ...d.session, work: "running", workError: null } }));
  const workMsg = s.work === "running" ? t("clinical.session.work.running")
    : s.work === "failed" ? (s.workError === "mux_down" || s.workError === "interrupted" ? t(`clinical.session.work.${s.workError}`) : s.workError?.startsWith("clinical.") ? t(s.workError, { what: t("clinical.purposeWhat.notes") }) : t("clinical.session.work.failed")) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <Link href={`/clinical/clients/${c.id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft aria-hidden className="size-4" />{t("clinical.session.back", { name: c.label })}</Link>
      <PageHeader title={`${t(`clinical.kind.${s.kind}`)}: ${c.label}`} lead={<span className="tabular-nums">{fmt(s.startsAt, "dateLong")}, {fmt(s.startsAt, "time")}</span>}
        actions={signed ? <Badge tone="accent">{t("clinical.item.status.signed")}</Badge> : undefined} />

      {data.consent.state !== "valid" && data.consent.state !== "review_soon" && (
        <p className="mb-6 rounded-lg bg-danger-tint px-4 py-3 text-sm text-danger">{t(`clinical.consent.state.${data.consent.state}`)}. {t("clinical.consent.none")}</p>
      )}

      {risks.length > 0 && (
        <Section title={t("clinical.home.risks")} className="mb-8">
          <ul className="space-y-2">{risks.map((r) => <ItemCard key={r.id} item={r} canDecide={mine} title={t(`clinical.item.risk.${String(r.content.category)}`)} />)}</ul>
        </Section>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section title={t("clinical.session.note")}>
          {signed && <SignedNote item={signed} />}
          {!signed && note && mine && <NoteEditor key={note.id + note.version} item={note} discipline={s.discipline} />}
          {!signed && !note && (
            <div className="space-y-3 rounded-lg bg-surface-2/60 p-4 text-sm text-muted">
              <p>{s.hasTranscript ? t("clinical.session.noteDraft") : t("clinical.session.noTranscript")}</p>
              {mine && data.consent.allowed.notes && (
                <Button size="sm" variant="secondary" onClick={async () => { await call(`/api/clinical/sessions/${s.id}/note`, { body: {} }); router.refresh(); }}>
                  <PenLine aria-hidden className="size-4" />{t("clinical.session.writeNote")}
                </Button>
              )}
            </div>
          )}
        </Section>

        <div className="space-y-8">
          {mine && !signed && (
            <Section title={t("clinical.session.transcript")}>
              <div className="space-y-3">
                <Recorder sessionId={s.id} canRecord={data.consent.allowed.recording && data.consent.allowed.transcription} canDictate={data.consent.allowed.notes} onSent={kickoff} />
                {workMsg && <p role="status" className={clsx("text-sm", s.work === "failed" ? "text-warn" : "text-muted")}>{workMsg}</p>}
                {data.consent.allowed.notes && <TypedTranscript sessionId={s.id} onSent={kickoff} />}
                {s.hasTranscript && !running && (
                  <Button size="sm" variant="ghost" onClick={async () => { const r = await call(`/api/clinical/sessions/${s.id}/draft`, { body: {} }); if (!r.error) kickoff(); }}>
                    <RefreshCw aria-hidden className="size-4" />{t("clinical.session.redraft")}
                  </Button>
                )}
              </div>
            </Section>
          )}
          {s.hasAudio && (
            <div>
              <p className="mb-1 text-sm text-muted">{t("clinical.session.play")}</p>
              <audio controls preload="none" src={`/api/clinical/sessions/${s.id}/audio`} className="w-full" />
            </div>
          )}
          {data.transcript && (
            <details className="rounded-lg bg-surface p-4" open={!note && !signed}>
              <summary className="cursor-pointer font-medium">{t("clinical.session.transcript")}</summary>
              <div className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto font-read text-sm/relaxed">
                {data.transcript.segments.length
                  ? data.transcript.segments.map((g, i) => <p key={i}><span className="mr-2 font-sans text-xs tabular-nums text-muted">{fmtTime(g.start)}</span>{g.text}</p>)
                  : <p className="whitespace-pre-wrap">{data.transcript.text}</p>}
              </div>
            </details>
          )}
        </div>
      </div>

      <Section title={t("clinical.session.suggestions")} className="mt-10">
        <p className="-mt-2 mb-3 text-sm text-muted">{t("clinical.session.suggestionsLead")}</p>
        {data.analysisHidden && <p className="mb-3 text-sm text-muted">{t("clinical.client.analysisHidden")}</p>}
        <Suggestions items={suggestions} canWrite={mine} empty={t("clinical.session.noSuggestions")} />
      </Section>
    </div>
  );
}

function SignedNote({ item }: { item: ItemView }) {
  const t = useT();
  const fmt = useFormatDate();
  return (
    <div className="rounded-lg bg-surface p-4">
      <p className="mb-3 text-sm text-muted">{t("clinical.session.noteSigned", { name: item.decidedByName ?? "", date: fmt(item.decidedAt ?? item.updatedAt, "dateTime") })}</p>
      <div className="whitespace-pre-wrap font-read text-[15px]/relaxed">{String(item.content.text ?? "")}</div>
    </div>
  );
}

function NoteEditor({ item, discipline }: { item: ItemView; discipline: "psychology" | "medical" }) {
  const t = useT();
  const router = useRouter();
  const { decide, busy, error, setError } = useDecide();
  const initial = (item.content.sections ?? {}) as Record<string, string>;
  const [sections, setSections] = useState<Record<string, string>>(initial);
  const [extra, setExtra] = useState(String(item.content.extra ?? ""));
  const [saved, setSaved] = useState<boolean | null>(null);
  const content = { sections, extra };
  return (
    <div className="space-y-4 rounded-lg bg-surface p-4">
      <p className="text-sm text-warn">{t("clinical.session.noteDraft")}</p>
      {NOTE_SECTIONS[discipline].map((k) => (
        <Field key={k} label={t(`clinical.section.${k}`)}>
          <Textarea className="font-read" rows={k === "plan" ? 3 : 5} value={sections[k] ?? ""} onChange={(e) => { setSections({ ...sections, [k]: e.target.value }); setSaved(false); }} />
        </Field>
      ))}
      <Field label={t("clinical.session.extra")}>
        <Textarea className="font-read" rows={3} value={extra} onChange={(e) => { setExtra(e.target.value); setSaved(false); }} />
      </Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy === item.id} onClick={() => decide(item.id, "sign", { content, baseVersion: item.version })}>{busy === item.id ? t("clinical.session.signing") : t("clinical.session.sign")}</Button>
        <Button variant="secondary" disabled={saved !== false} onClick={async () => {
          const r = await call(`/api/clinical/items/${item.id}`, { method: "PATCH", body: { content, baseVersion: item.version } }, t("clinical.err.offline"));
          if (r.error) setError(r.error); else { setSaved(true); router.refresh(); }
        }}>{t("clinical.session.saveDraft")}</Button>
        {saved && <span role="status" className="text-sm text-muted">{t("clinical.session.saved")}</span>}
      </div>
    </div>
  );
}

function TypedTranscript({ sessionId, onSent }: { sessionId: string; onSent: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="text-sm text-accent hover:underline" onClick={() => setOpen(true)}>{t("clinical.session.typed")}</button>;
  return (
    <div className="space-y-2">
      <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("clinical.session.typedPlaceholder")} aria-label={t("clinical.session.typed")} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={!text.trim()} onClick={async () => {
          const r = await call(`/api/clinical/sessions/${sessionId}/transcript`, { body: { text } }, t("clinical.err.offline"));
          if (r.error) setError(r.error); else { setOpen(false); setText(""); onSent(); }
        }}>{t("clinical.session.useTranscript")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("clinical.consent.cancel")}</Button>
      </div>
    </div>
  );
}
