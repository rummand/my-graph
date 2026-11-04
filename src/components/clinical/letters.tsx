"use client";
/** Letters (referral, discharge, to the patient): drafted from the signed record, edited and signed; signed letters live in Documents. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileStack, PenLine } from "lucide-react";
import { Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useFormatDate, useLocale, useT } from "@/lib/i18n/client";
import { LETTER_KINDS, type LetterKind } from "@/lib/clinical/pure";
import type { ItemView } from "@/lib/clinical/items";
import { call } from "./api";
import { useDecide } from "./item-card";

export function Letters({ clientId, items, canWrite, allowed }: { clientId: string; items: ItemView[]; canWrite: boolean; allowed: boolean }) {
  const t = useT();
  const fmt = useFormatDate();
  const letters = items.filter((i) => i.kind === "letter" && i.status !== "dismissed");
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      {letters.length === 0 && <p className="text-sm text-muted">{t("clinical.letters.none")}</p>}
      <ul className="space-y-3">
        {letters.map((l) => l.status === "proposed" && canWrite ? <LetterEditor key={l.id} item={l} /> : (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface p-3.5">
            <span className="min-w-0">
              <span className="font-medium">{String(l.content.subject || l.title || t(`clinical.letters.kind.${String(l.content.letterKind)}`))}</span>
              <span className="block text-sm text-muted">{t(`clinical.letters.kind.${String(l.content.letterKind)}`)}{l.content.recipient ? `, ${String(l.content.recipient)}` : ""}{l.decidedAt ? `, ${fmt(l.decidedAt)}` : ""}</span>
            </span>
            {l.artifactId ? <a href={`/artifacts/${l.artifactId}`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline"><FileStack aria-hidden className="size-4" />{t("clinical.letters.inDocuments")}</a>
              : <Badge>{t(`clinical.item.status.${l.status}`)}</Badge>}
          </li>
        ))}
      </ul>
      {canWrite && allowed && !open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><PenLine aria-hidden className="size-4" />{t("clinical.letters.new")}</Button>}
      {open && <NewLetter clientId={clientId} onDone={() => setOpen(false)} />}
    </div>
  );
}

function NewLetter({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [kind, setKind] = useState<LetterKind>("referral");
  const [recipient, setRecipient] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form className="space-y-3 rounded-lg bg-surface p-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setMsg(null);
      const r = await call<{ usedModel: boolean }>(`/api/clinical/clients/${clientId}/letters`, { body: { letterKind: kind, recipient, instructions: instructions || null, lang: locale === "da" ? "da" : "en" } }, t("clinical.err.offline"));
      setBusy(false);
      if (r.error) { setMsg(r.error); return; }
      if (!r.data?.usedModel) setMsg(t("clinical.letters.noModel"));
      else onDone();
      router.refresh();
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("clinical.letters.new")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as LetterKind)}>
            {LETTER_KINDS.map((k) => <option key={k} value={k}>{t(`clinical.letters.kind.${k}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("clinical.letters.recipient")}><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder={t("clinical.letters.recipientPlaceholder")} maxLength={300} /></Field>
      </div>
      <Field label={t("clinical.letters.instructions")}><Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={1000} /></Field>
      {msg && <p role="status" className="text-sm text-warn">{msg}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? t("clinical.letters.drafting") : t("clinical.letters.draft")}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t("clinical.consent.cancel")}</Button>
      </div>
    </form>
  );
}

function LetterEditor({ item }: { item: ItemView }) {
  const t = useT();
  const router = useRouter();
  const { decide, busy, error, setError } = useDecide();
  const [subject, setSubject] = useState(String(item.content.subject ?? ""));
  const [recipient, setRecipient] = useState(String(item.content.recipient ?? ""));
  const [text, setText] = useState(String(item.content.text ?? ""));
  const [saved, setSaved] = useState(false);
  const content = { subject, recipient, text };
  return (
    <li className="space-y-3 rounded-lg bg-surface p-4">
      <p className="text-sm text-muted">{t(`clinical.letters.kind.${String(item.content.letterKind)}`)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("clinical.letters.subject")}><Input value={subject} onChange={(e) => { setSubject(e.target.value); setSaved(false); }} /></Field>
        <Field label={t("clinical.letters.recipient")}><Input value={recipient} onChange={(e) => { setRecipient(e.target.value); setSaved(false); }} /></Field>
      </div>
      <Field label={t("clinical.letters.body")}><Textarea className="font-read" rows={12} value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} /></Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy === item.id || !text.trim()} onClick={() => decide(item.id, "sign", { content, baseVersion: item.version })}>{t("clinical.letters.sign")}</Button>
        <Button variant="secondary" onClick={async () => {
          const r = await call(`/api/clinical/items/${item.id}`, { method: "PATCH", body: { content, baseVersion: item.version } }, t("clinical.err.offline"));
          if (r.error) setError(r.error); else { setSaved(true); router.refresh(); }
        }}>{t("clinical.session.saveDraft")}</Button>
        <Button variant="ghost" onClick={() => decide(item.id, "dismiss", { baseVersion: item.version })}>{t("clinical.item.dismiss")}</Button>
        {saved && <span role="status" className="text-sm text-muted">{t("clinical.session.saved")}</span>}
      </div>
    </li>
  );
}
