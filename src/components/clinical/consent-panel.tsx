"use client";
/**
 * Consent first: the state in one line, which purposes are allowed now, the signed form, review date, who the record
 * may be shared with; register a signed consent, renew, withdraw; and the consent's history.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Check, FileText, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { PURPOSES, type Purpose } from "@/lib/clinical/pure";
import type { ClientPageData } from "@/lib/clinical/views";
import { call } from "./api";
import { DocPicker } from "./doc-picker";

const day = (d: Date) => d.toISOString().slice(0, 10);

export function ConsentPanel({ data }: { data: ClientPageData }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const mine = data.client.access === "clinician";
  const [form, setForm] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const state = data.consent.state;
  const good = state === "valid";
  const current = data.consents.find((c) => c.inForce) ?? null;
  return (
    <section aria-labelledby="consent" className={clsx("rounded-lg p-4", good ? "bg-surface" : state === "review_soon" ? "bg-warn-tint" : "bg-danger-tint")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="consent" className={clsx("flex items-center gap-2 text-lg font-semibold", !good && (state === "review_soon" ? "text-warn" : "text-danger"))}>
            {good ? <ShieldCheck aria-hidden className="size-5 text-accent" /> : <ShieldAlert aria-hidden className="size-5" />}
            {t(`clinical.consent.state.${state}`)}
          </h2>
          {current && (
            <p className="mt-0.5 text-sm text-muted">
              {t("clinical.consent.signedOn", { date: fmt(current.signedAt) })}
              {current.reviewAt && <>, {t("clinical.consent.reviewOn", { date: fmt(current.reviewAt) }).toLowerCase()}</>}
              {current.document && <>. <a className="text-accent hover:underline" href={`/library/${current.document.id}`}><FileText aria-hidden className="mr-0.5 inline size-3.5" />{current.document.title}</a></>}
            </p>
          )}
          {state === "none" && <p className="mt-0.5 text-sm text-muted">{t("clinical.consent.none")}</p>}
        </div>
        {mine && !form && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={good ? "secondary" : "primary"} onClick={() => setForm(true)}>{t("clinical.consent.register")}</Button>
            {current && <Button size="sm" variant="ghost" onClick={() => setWithdrawing(current.id)}>{t("clinical.consent.withdraw")}</Button>}
          </div>
        )}
      </div>

      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t("clinical.consent.purposes")}>
        {PURPOSES.map((p) => (
          <li key={p}>
            <span title={t(`clinical.consent.purposeHint.${p}`)} className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs",
              data.consent.allowed[p] ? "bg-accent-tint text-accent" : "bg-surface-2 text-muted line-through decoration-muted/50")}>
              {data.consent.allowed[p] ? <Check aria-hidden className="size-3" /> : <X aria-hidden className="size-3" />}
              {t(`clinical.consent.purpose.${p}`)}
              <span className="sr-only">: {data.consent.allowed[p] ? t("clinical.consent.allowed") : t("clinical.consent.notAllowed")}</span>
            </span>
          </li>
        ))}
      </ul>

      {form && <ConsentForm data={data} onDone={() => { setForm(false); router.refresh(); }} />}
      {withdrawing && <WithdrawForm id={withdrawing} onDone={() => { setWithdrawing(null); router.refresh(); }} />}

      {data.consentEvents.length > 0 && (
        <div className="mt-3">
          <button type="button" className="text-sm text-muted hover:text-fg" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            {t("clinical.consent.history")} ({data.consentEvents.length})
          </button>
          {showHistory && (
            <ol className="mt-2 space-y-1 border-l border-line pl-3 text-sm">
              {data.consentEvents.map((e) => (
                <li key={e.id}>
                  <span className="tabular-nums text-muted">{fmt(e.at, "dateTime")}</span>{" "}
                  {t(`clinical.consent.event.${e.action}`, { name: e.actorName ?? "" })}
                  {Array.isArray(e.after?.purposes) && <span className="text-muted">: {(e.after!.purposes as string[]).map((p) => t(`clinical.consent.purpose.${p}`)).join(", ")}</span>}
                  {typeof e.after?.withdrawnNote === "string" && e.after.withdrawnNote && <span className="block italic text-muted">“{e.after.withdrawnNote}”</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function ConsentForm({ data, onDone }: { data: ClientPageData; onDone: () => void }) {
  const t = useT();
  const now = new Date();
  const [purposes, setPurposes] = useState<Purpose[]>(["recording", "transcription", "notes"]);
  const [shared, setShared] = useState<string[]>([]);
  const [signedAt, setSignedAt] = useState(day(now));
  const [reviewAt, setReviewAt] = useState(day(new Date(now.getTime() + 365 * 86_400_000)));
  const [doc, setDoc] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  return (
    <form className="mt-4 space-y-4 rounded-lg bg-surface p-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const r = await call(`/api/clinical/clients/${data.client.id}/consents`, {
        body: { purposes, sharedWith: purposes.includes("sharing") ? shared : [], signedAt, reviewAt: reviewAt || null, documentSourceId: doc, note },
      }, t("clinical.err.offline"));
      setBusy(false);
      if (r.error) setError(r.error); else onDone();
    }}>
      <h3 className="font-semibold">{t("clinical.consent.registerTitle")}</h3>
      <Field label={t("clinical.consent.document")} hint={t("clinical.consent.documentHint")}>
        <span className="block"><DocPicker value={doc} onChange={setDoc} label={t("clinical.consent.document")} /></span>
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t("clinical.consent.purposes")}</legend>
        <div className="space-y-1.5">
          {PURPOSES.map((p) => (
            <label key={p} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2/60">
              <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={purposes.includes(p)} onChange={() => setPurposes(toggle(purposes, p))} />
              <span><span className="font-medium">{t(`clinical.consent.purpose.${p}`)}</span><span className="block text-sm text-muted">{t(`clinical.consent.purposeHint.${p}`)}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {purposes.includes("sharing") && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t("clinical.consent.colleagues")}</legend>
          {data.colleagues.length === 0 ? <p className="text-sm text-muted">{t("clinical.client.noColleagues")}</p> : (
            <div className="flex flex-wrap gap-2">
              {data.colleagues.map((c) => (
                <label key={c.id} className={clsx("inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-sm", shared.includes(c.id) ? "bg-accent-tint text-accent" : "bg-surface-2")}>
                  <input type="checkbox" className="sr-only" checked={shared.includes(c.id)} onChange={() => setShared(toggle(shared, c.id))} />
                  {shared.includes(c.id) && <Check aria-hidden className="size-3.5" />}{c.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("clinical.consent.signedAt")}><Input type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} required /></Field>
        <Field label={t("clinical.consent.reviewAt")} hint={t("clinical.consent.reviewHint")}><Input type="date" value={reviewAt} onChange={(e) => setReviewAt(e.target.value)} /></Field>
      </div>
      <Field label={t("clinical.consent.note")}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !purposes.length}>{t("clinical.consent.save")}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t("clinical.consent.cancel")}</Button>
      </div>
    </form>
  );
}

function WithdrawForm({ id, onDone }: { id: string; onDone: () => void }) {
  const t = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="mt-4 space-y-3 rounded-lg bg-surface p-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const r = await call(`/api/clinical/consents/${id}/withdraw`, { body: { note } }, t("clinical.err.offline"));
      setBusy(false);
      if (r.error) setError(r.error); else onDone();
    }}>
      <h3 className="font-semibold">{t("clinical.consent.withdrawTitle")}</h3>
      <p className="text-sm text-muted">{t("clinical.consent.withdrawLead")}</p>
      <Field label={t("clinical.consent.withdrawNote")}><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={busy}>{t("clinical.consent.confirmWithdraw")}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t("clinical.consent.cancel")}</Button>
      </div>
    </form>
  );
}

export function SharingRow({ data }: { data: ClientPageData }) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  if (data.client.access !== "clinician") return null;
  const allowedIds = new Set(data.consents.filter((c) => c.inForce && c.purposes.includes("sharing")).flatMap((c) => c.sharedWith.map((s) => s.id)));
  const shared = new Set(data.sharedWith.map((s) => s.id));
  const candidates = data.colleagues.filter((c) => allowedIds.has(c.id));
  const act = async (userId: string, on: boolean) => {
    setError(null);
    const r = await call(`/api/clinical/clients/${data.client.id}/share`, { method: on ? "POST" : "DELETE", body: { userId } }, t("clinical.err.offline"));
    if (r.error) setError(r.error); else router.refresh();
  };
  return (
    <div className="text-sm">
      <p className="text-muted">{t("clinical.client.sharing")}</p>
      {candidates.length === 0 && data.sharedWith.length === 0 ? <p className="mt-1">{data.consent.allowed.sharing ? t("clinical.client.notShared") : t("clinical.client.noColleagues")}</p> : (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {[...new Map([...candidates, ...data.sharedWith].map((c) => [c.id, c])).values()].map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => act(c.id, !shared.has(c.id))} aria-pressed={shared.has(c.id)}
                className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-1", shared.has(c.id) ? "bg-accent-tint text-accent" : "bg-surface-2 text-muted hover:text-fg")}>
                {shared.has(c.id) ? <Check aria-hidden className="size-3" /> : null}{c.name}
                <span className="sr-only">{shared.has(c.id) ? t("clinical.client.stopSharing") : t("clinical.client.shareWith")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
