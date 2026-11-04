"use client";
/**
 * A client's or patient's record. Consent first; then what the clinician needs for the next meeting: sessions,
 * signed notes, measures (psychology) or medication, labs and diagnoses (medical), themes and hypotheses, letters,
 * follow-ups. Facts about the person's life (family, home, work) live on their living profile, linked at the top.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronRight, Plus, Sparkles } from "lucide-react";
import { Badge, Button, Field, Input, PageHeader, Section, Select } from "@/components/ui";
import { useFormatDate, useLocale, useT } from "@/lib/i18n/client";
import type { ClientPageData } from "@/lib/clinical/views";
import type { ItemView } from "@/lib/clinical/items";
import { call } from "./api";
import { ConsentPanel, SharingRow } from "./consent-panel";
import { ItemCard } from "./item-card";
import { Labs } from "./labs";
import { Letters } from "./letters";
import { Measures } from "./measures";

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ClientRecordView({ data }: { data: ClientPageData }) {
  const t = useT();
  const fmt = useFormatDate();
  const c = data.client;
  const mine = c.access === "clinician";
  const medical = c.discipline === "medical";
  const items = data.items;
  const of = (k: string) => items.filter((i) => i.kind === k);
  const risks = of("risk").filter((r) => r.status === "open");
  const notes = of("note").filter((n) => n.status === "signed");
  const analysis = data.consent.allowed.analysis;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={c.label}
        lead={<>
          {t(`clinical.kind.${c.kind}`)}, {t("clinical.client.since", { date: fmt(c.createdAt) })}
          {!mine && c.ownerName && <span className="mt-1 block text-sm">{t("clinical.client.sharedRead", { name: c.ownerName })}</span>}
          {c.reason && <span className="mt-1 block text-sm">{c.reason}</span>}
        </>}
        actions={<Link href={`/people/${c.id}`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline" title={t("clinical.client.profileHint", { name: c.label })}>
          {t("clinical.client.profile")}<ArrowUpRight aria-hidden className="size-4" />
        </Link>} />

      <div className="mb-10 grid gap-4 lg:grid-cols-[1fr_16rem]">
        <ConsentPanel data={data} />
        <div className="rounded-lg bg-surface p-4"><SharingRow data={data} />{!mine && <p className="text-sm text-muted">{t("clinical.client.clinician", { name: c.ownerName ?? "" })}</p>}</div>
      </div>

      {risks.length > 0 && (
        <Section title={t("clinical.home.risks")} className="mb-10">
          <ul className="space-y-2">{risks.map((r) => <ItemCard key={r.id} item={r} canDecide={mine} title={t(`clinical.item.risk.${String(r.content.category)}`)} detail={r.content.fromMeasure ? t("clinical.item.fromMeasure") : null} />)}</ul>
        </Section>
      )}

      <div className="grid gap-10 lg:grid-cols-2">
        <Section title={t(medical ? "clinical.client.sections.consultations" : "clinical.client.sections.sessions")}
          action={mine ? <NewSession clientId={c.id} medical={medical} /> : undefined}>
          {data.sessions.length === 0 ? <p className="text-sm text-muted">{t("clinical.client.noSessions")}</p> : (
            <ul className="divide-y divide-line">
              {data.sessions.map((s) => (
                <li key={s.id}>
                  <Link href={`/clinical/sessions/${s.id}`} className="-mx-3 flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-surface-2/60">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium tabular-nums">{fmt(s.startsAt, "dateTime")}</span>
                      {s.title && <span className="block text-sm text-muted">{s.title}</span>}
                    </span>
                    {s.status === "signed" ? <Badge tone="accent">{t("clinical.item.status.signed")}</Badge> : s.work === "running" ? <Badge>{t("clinical.home.working")}</Badge> : null}
                    <ChevronRight aria-hidden className="size-4 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("clinical.client.sections.summary")}>
          <Summary clientId={c.id} items={of("summary")} canWrite={mine} allowed={analysis} />
        </Section>

        <Section title={t("clinical.client.sections.notes")} className="lg:col-span-2">
          {notes.length === 0 ? <p className="text-sm text-muted">{t("clinical.client.noNotes")}</p> : (
            <ul className="space-y-3">
              {notes.map((n) => (
                <li key={n.id} className="rounded-lg bg-surface p-4">
                  <p className="mb-2 text-sm text-muted">{t("clinical.session.noteSigned", { name: n.decidedByName ?? "", date: fmt(n.decidedAt ?? n.updatedAt, "dateTime") })}</p>
                  <div className="whitespace-pre-wrap font-read text-[15px]/relaxed">{String(n.content.text ?? "")}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {medical ? (
          <>
            <Section title={t("clinical.client.sections.medication")}>
              <Suggestions items={[...of("medication"), ...of("allergy")]} canWrite={mine} empty={t("clinical.medication.none")} />
            </Section>
            <Section title={t("clinical.client.sections.codes")}>
              {analysis ? <Suggestions items={of("code")} canWrite={mine} empty={t("clinical.codes.none")} /> : <p className="text-sm text-muted">{t("clinical.client.analysisHidden")}</p>}
            </Section>
            <Section title={t("clinical.client.sections.labs")} className="lg:col-span-2">
              <Labs clientId={c.id} items={items} canWrite={mine} allowed={data.consent.allowed.notes} />
            </Section>
            <Section title={t("clinical.client.sections.letters")} className="lg:col-span-2">
              <Letters clientId={c.id} items={items} canWrite={mine} allowed={data.consent.allowed.notes} />
            </Section>
          </>
        ) : (
          <>
            <Section title={t("clinical.client.sections.measures")} className="lg:col-span-2">
              <Measures clientId={c.id} items={items} canWrite={mine} allowed={data.consent.allowed.notes} />
            </Section>
            <Section title={t("clinical.client.sections.themes")}>
              {analysis ? <Suggestions items={of("theme")} canWrite={mine} empty={t("clinical.session.noSuggestions")} /> : <p className="text-sm text-muted">{t("clinical.client.analysisHidden")}</p>}
            </Section>
            <Section title={t("clinical.client.sections.hypotheses")}>
              {analysis ? <Suggestions items={of("hypothesis")} canWrite={mine} empty={t("clinical.session.noSuggestions")} /> : <p className="text-sm text-muted">{t("clinical.client.analysisHidden")}</p>}
            </Section>
          </>
        )}

        <Section title={t("clinical.client.sections.followups")} id="followups" className="lg:col-span-2">
          <Followups clientId={c.id} items={of("followup")} canWrite={mine} allowed={data.consent.allowed.notes} />
        </Section>
      </div>
    </div>
  );
}

/** Title and detail line for a suggestion of any kind. */
export function describe(i: ItemView, t: (k: string, v?: Record<string, string | number>) => string, fmt?: (d: string) => string): { title: string; detail: string | null } {
  const c = i.content as Record<string, string | number | null | undefined>;
  switch (i.kind) {
    case "code": return { title: `${c.code} ${c.label ?? ""}`.trim(), detail: `${c.system}${typeof c.confidence === "number" ? `, ${t("clinical.item.confidence", { n: Math.round(c.confidence * 100) })}` : ""}` };
    case "medication": return { title: String(c.name ?? i.title ?? ""), detail: [c.dose, c.frequency, c.change].filter(Boolean).join(", ") || null };
    case "allergy": return { title: `${t("clinical.medication.allergy")}: ${c.substance ?? i.title}`, detail: c.reaction ? String(c.reaction) : null };
    case "hypothesis": return { title: String(c.statement ?? i.title ?? ""), detail: typeof c.confidence === "number" ? t("clinical.item.confidence", { n: Math.round(c.confidence * 100) }) : null };
    case "followup": return { title: String(c.title ?? i.title ?? ""), detail: c.dueAt ? t("clinical.home.due", { date: fmt ? fmt(String(c.dueAt)) : String(c.dueAt).slice(0, 10) }) : null };
    default: return { title: String(i.title ?? c.label ?? ""), detail: null };
  }
}

export function Suggestions({ items, canWrite, empty }: { items: ItemView[]; canWrite: boolean; empty: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const shown = items.filter((i) => i.status !== "dismissed" || canWrite).sort((a, b) => (a.status === "proposed" ? -1 : 0) - (b.status === "proposed" ? -1 : 0));
  if (!shown.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {shown.slice(0, 30).map((i) => {
        const d = describe(i, t, (x) => fmt(x));
        const against = Array.isArray(i.content.against) ? (i.content.against as string[]) : [];
        return (
          <ItemCard key={i.id} item={i} canDecide={canWrite} title={d.title} detail={d.detail}>
            {against.length > 0 && <p className="mt-2 text-sm text-muted">{t("clinical.item.against")}: {against.map((q) => `“${q}”`).join(" ")}</p>}
          </ItemCard>
        );
      })}
    </ul>
  );
}

function NewSession({ clientId, medical }: { clientId: string; medical: boolean }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(localInput(new Date()));
  const [lang, setLang] = useState(locale === "da" ? "da" : "en");
  const [error, setError] = useState<string | null>(null);
  if (!open) return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus aria-hidden className="size-4" />{t(medical ? "clinical.client.newConsultation" : "clinical.client.newSession")}</Button>;
  return (
    <div className="relative">
    <form className="absolute right-0 top-0 z-10 w-72 space-y-3 rounded-lg bg-surface p-4 shadow-float" onSubmit={async (e) => {
      e.preventDefault();
      const r = await call<{ id: string }>(`/api/clinical/clients/${clientId}/sessions`, { body: { startsAt: new Date(when).toISOString(), language: lang } }, t("clinical.err.offline"));
      if (r.error || !r.data) { setError(r.error ?? null); return; }
      router.push(`/clinical/sessions/${r.data.id}`);
    }}>
      <Field label={t("clinical.client.when")}><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required /></Field>
      <Field label={t("clinical.client.language")}>
        <Select value={lang} onChange={(e) => setLang(e.target.value)}><option value="da">Dansk</option><option value="en">English</option></Select>
      </Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2"><Button type="submit">{t("clinical.client.create")}</Button><Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("clinical.consent.cancel")}</Button></div>
    </form>
    </div>
  );
}

function Summary({ clientId, items, canWrite, allowed }: { clientId: string; items: ItemView[]; canWrite: boolean; allowed: boolean }) {
  const t = useT();
  const fmt = useFormatDate();
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!allowed) return <p className="text-sm text-muted">{t("clinical.client.analysisHidden")}</p>;
  const s = items.find((i) => i.status === "proposed");
  const bullets = Array.isArray(s?.content.bullets) ? (s!.content.bullets as string[]) : [];
  return (
    <div>
      {s ? (
        <div className="rounded-lg bg-surface p-4">
          <p className="mb-2 text-xs text-muted">{fmt(s.createdAt, "dateTime")}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </div>
      ) : <p className="text-sm text-muted">{t("clinical.summary.none")}</p>}
      {canWrite && (
        <Button size="sm" variant="secondary" className="mt-3" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          const r = await call(`/api/clinical/clients/${clientId}/summary`, { body: { lang: locale === "da" ? "da" : "en" } }, t("clinical.err.offline"));
          setBusy(false);
          if (r.error) setError(r.error); else router.refresh();
        }}><Sparkles aria-hidden className="size-4" />{busy ? t("clinical.summary.making") : t("clinical.summary.make")}</Button>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

function Followups({ clientId, items, canWrite, allowed }: { clientId: string; items: ItemView[]; canWrite: boolean; allowed: boolean }) {
  const t = useT();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const open = items.filter((i) => i.status === "proposed" || i.status === "confirmed");
  return (
    <div className="space-y-3">
      <Suggestions items={open} canWrite={canWrite} empty={t("clinical.home.followupsEmpty")} />
      {canWrite && allowed && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await call(`/api/clinical/clients/${clientId}/followups`, { body: { title, dueAt: due } }, t("clinical.err.offline"));
          if (r.error) setError(r.error); else { setTitle(""); router.refresh(); }
        }}>
          <Field label={t("clinical.followup.what")} className="min-w-0 flex-1"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
          <Field label={t("clinical.followup.due")} className="w-40"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" disabled={!title.trim()}>{t("clinical.followup.save")}</Button>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
