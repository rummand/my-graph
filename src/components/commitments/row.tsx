"use client";
import Link from "next/link";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { motion } from "motion/react";
import { AlarmClock, AlertTriangle, Ban, Check, ChevronDown, MoreHorizontal, Pencil, Play, RotateCcw, UserRoundCog } from "lucide-react";
import { Avatar, Button, CitationChip, Field, Input } from "@/components/ui";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate } from "@/lib/i18n/dates";
import { leadDaysOf, urgencyOf, type CommitmentView, type Party } from "@/lib/commitments/pure";
import type { Action } from "./client";
import type { CommitmentFlag } from "@/lib/commitments/watch/flags";
import { MenuItem, Pop } from "./pop";
import { detailLine, dueWords, KIND_ICON, recurrenceWords, snoozeChoices, urgencyTone } from "./words";

export type RowProps = {
  c: CommitmentView;
  now: Date;
  tz: string;
  /** People who can be made responsible (Reassign); empty hides it. */
  everyone: Party[];
  canWrite: boolean;
  onAct: (c: CommitmentView, a: Action) => Promise<boolean>;
  /** Hide the owner avatars (on a person's own page). */
  hideOwner?: boolean;
  /** Today's cards: a little more air, on their own surface. */
  card?: boolean;
  /** A narrow column (a person's page): no kind mark, Done as an icon. */
  compact?: boolean;
  /** Two sources that disagree about it (from the watch). */
  flags?: CommitmentFlag[];
};

const DROP_REASONS = ["not_mine", "not_a_commitment", "duplicate", "cancelled"] as const;

/** One commitment: the sentence, when, whose, with whom, where it came from, and what you can do about it. */
export function CommitmentRow({ c, now, tz, everyone, canWrite, onAct, hideOwner, card, compact, flags }: RowProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"none" | "edit" | "doneNote">("none");
  const [busy, setBusy] = useState(false);
  const detailsId = useId();
  const u = urgencyOf(c.props, now, tz);
  const tone = urgencyTone(u);
  const due = dueWords(c, t, locale, tz, now);
  const Icon = KIND_ICON[c.props.kind];
  const line = detailLine(c, t, locale);
  const owners = c.responsible.filter((p) => p.type === "person");
  const isOpen = c.props.status === "open";
  const source = c.sources[0];
  const hasDetails = !!(c.props.consequence || source?.quote || c.reminder || c.props.recurrence || c.props.doneNote || c.about.length || c.summary);

  const run = async (a: Action) => {
    setBusy(true);
    const ok = await onAct(c, a);
    setBusy(false);
    if (ok) setMode("none");
  };

  return (
    <motion.li layout="position" initial={false} exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={clsx("min-w-0", card ? "rounded-lg bg-surface px-4 py-3.5" : compact ? "px-3.5 py-3" : "px-4 py-3 sm:px-5")}>
      <div className={clsx("flex items-start", compact ? "gap-2" : "gap-3")}>
        {!compact && (
          <span aria-hidden className={clsx("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4",
            !isOpen ? "bg-surface-2 text-muted" : tone === "danger" ? "bg-danger-tint text-danger" : tone === "warn" ? "bg-warn-tint text-warn" : "bg-surface-2 text-fg/80")}>
            {isOpen ? <Icon /> : <Check />}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <Link href={`/node/${c.id}`} title={c.props.consequence ? `${t("commitments.row.ifMissed")}: ${c.props.consequence}` : undefined}
              className={clsx("min-w-0 break-words font-medium hover:underline", !isOpen && "text-muted line-through decoration-muted/50")}>
              {c.label}
            </Link>
            <p className="shrink-0 text-sm">
              {!isOpen
                ? <span className="text-muted">{c.props.status === "done" && c.props.doneAt ? t("commitments.due.done", { date: formatDate(c.props.doneAt, "date", { locale, timeZone: tz, now }) }) : t(`commitments.status.${c.props.status}`)}</span>
                : due
                  ? <><time dateTime={c.props.dueAt!} className="text-fg">{due.date}</time>{" "}
                      <span className={clsx(tone === "danger" ? "font-medium text-danger" : tone === "warn" ? "font-medium text-warn" : "text-muted")}>{due.rel}</span></>
                  : <span className="text-muted">{t("commitments.due.none")}</span>}
            </p>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
            {!hideOwner && (owners.length
              ? <span className="inline-flex items-center gap-1.5" title={t("commitments.row.responsible", { names: owners.map((o) => o.label).join(", ") })}>
                  <span className="flex -space-x-1">{owners.slice(0, 3).map((o) => <Avatar key={o.id} id={o.id} name={o.label} size={20} className="ring-2 ring-surface" />)}</span>
                  <span className="text-fg/80">{owners.map((o) => o.label.split(" ")[0]).join(", ")}</span>
                </span>
              : <span className="italic">{t("commitments.people.nobody")}</span>)}
            {line && <span>{line}</span>}
            {source && <CitationChip title={source.title} href={source.href} detail={source.page ? `p. ${source.page}` : undefined} />}
            {isOpen && c.props.snoozedUntil && Date.parse(c.props.snoozedUntil) > now.getTime() && (
              <span className="inline-flex items-center gap-1"><AlarmClock aria-hidden className="size-3.5" />{t("commitments.row.snoozed", { date: formatDate(c.props.snoozedUntil, "weekday", { locale, timeZone: tz, now }) })}</span>
            )}
            {isOpen && c.props.progressAt && <span className="inline-flex items-center gap-1"><Play aria-hidden className="size-3.5" />{t("commitments.row.started", { date: formatDate(c.props.progressAt, "date", { locale, timeZone: tz, now }) })}</span>}
            {c.clashes[0] && <span className="font-medium text-warn">{t("commitments.row.clashes", { name: c.clashes[0].label })}</span>}
            {hasDetails && (
              <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-0.5 rounded text-sm text-muted hover:text-fg">
                {open ? t("commitments.row.hideDetails") : t("commitments.row.details")}
                <ChevronDown aria-hidden className={clsx("size-3.5 transition-transform", open && "rotate-180")} />
              </button>
            )}
          </div>

          {isOpen && flags?.map((f) => (
            <p key={f.key} className="mt-2 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">
              <AlertTriangle aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />{f.text}{" "}
              {[f.a, f.b].filter((x) => x.href).map((x, i) => (
                <a key={i} href={x.href!} className="ml-1 font-medium underline decoration-warn/40 underline-offset-2 hover:decoration-warn">{x.title}</a>
              ))}
            </p>
          ))}

          {open && hasDetails && (
            <dl id={detailsId} className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
              {c.summary && <><dt className="text-muted">{t("commitments.detail.about")}</dt><dd>{c.summary}</dd></>}
              {c.about.length > 0 && <><dt className="text-muted">{t("commitments.detail.about")}</dt><dd>{c.about.map((a) => <Link key={a.id} href={a.type === "person" ? `/people/${a.id}` : `/node/${a.id}`} className="mr-2 text-accent hover:underline">{a.label}</Link>)}</dd></>}
              {c.props.consequence && <><dt className="text-muted">{t("commitments.row.ifMissed")}</dt><dd>{c.props.consequence}</dd></>}
              {source?.quote && <><dt className="text-muted">{t("commitments.detail.from")}</dt><dd><a href={source.href} className="font-read italic text-fg/90 hover:underline">{t("commitments.detail.quote", { quote: source.quote })}</a></dd></>}
              {c.reminder && isOpen && u !== "overdue" && <><dt className="text-muted">{t("commitments.detail.reminder")}</dt><dd>{`${formatDate(c.reminder.dueAt, "weekday", { locale, timeZone: tz, now })}. ${t("commitments.detail.leadDays", { count: leadDaysOf(c.props) })}`}</dd></>}
              {c.props.recurrence && <><dt className="text-muted">{t("commitments.detail.repeats")}</dt><dd>{recurrenceWords(c.props.recurrence, t)}</dd></>}
              {c.props.doneNote && <><dt className="text-muted">{t("commitments.status.done")}</dt><dd>{c.props.doneNote}</dd></>}
            </dl>
          )}

          {mode === "edit" && <EditForm c={c} tz={tz} busy={busy} onCancel={() => setMode("none")} onSave={(a) => run(a)} />}
          {mode === "doneNote" && <DoneNoteForm busy={busy} onCancel={() => setMode("none")} onSave={(note) => run({ action: "done", note })} />}
        </div>

        {canWrite && (
          <div className="flex shrink-0 items-center gap-0.5">
            {isOpen
              ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => run({ action: "done" })} title={t("commitments.actions.doneTitle", { label: c.label })} aria-label={t("commitments.actions.doneTitle", { label: c.label })}>
                  <Check aria-hidden className="size-4" /><span className={compact ? "sr-only" : "hidden sm:inline"}>{t("commitments.actions.done")}</span>
                </Button>
              : <Button variant="ghost" size="sm" disabled={busy} onClick={() => run({ action: "reopen" })}><RotateCcw aria-hidden className="size-4" />{t("commitments.actions.reopen")}</Button>}
            {isOpen && <MoreMenu c={c} now={now} tz={tz} everyone={everyone} busy={busy} run={run} setMode={setMode} />}
          </div>
        )}
      </div>
    </motion.li>
  );
}

function MoreMenu({ c, now, tz, everyone, busy, run, setMode }: {
  c: CommitmentView; now: Date; tz: string; everyone: Party[]; busy: boolean; run: (a: Action) => Promise<void>; setMode: (m: "edit" | "doneNote") => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [page, setPage] = useState<"main" | "snooze" | "reassign" | "drop">("main");
  const label = t("commitments.actions.more", { label: c.label });
  const snoozes = snoozeChoices(c.props.dueAt, now, tz);
  const owners = new Set(c.responsible.map((p) => p.id));
  return (
    <Pop label={page === "snooze" ? t("commitments.actions.snoozeTitle") : page === "reassign" ? t("commitments.actions.reassignTitle") : page === "drop" ? t("commitments.actions.dropTitle") : label}
      button={({ open, toggle, ref }) => (
        <button ref={ref} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} disabled={busy}
          onClick={() => { setPage("main"); toggle(); }}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-45">
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      )}>
      {(close) => page === "main" ? (
        <>
          {snoozes.length > 0 && <MenuItem icon={<AlarmClock />} hint={t("commitments.actions.snoozeHint")} onSelect={() => setPage("snooze")}>{t("commitments.actions.snooze")}</MenuItem>}
          {!c.props.progressAt && <MenuItem icon={<Play />} onSelect={() => { close(); void run({ action: "progress" }); }}>{t("commitments.actions.started")}</MenuItem>}
          {everyone.length > 0 && <MenuItem icon={<UserRoundCog />} onSelect={() => setPage("reassign")}>{t("commitments.actions.reassign")}</MenuItem>}
          <MenuItem icon={<Pencil />} onSelect={() => { close(); setMode("edit"); }}>{t("commitments.actions.edit")}</MenuItem>
          <MenuItem icon={<Check />} onSelect={() => { close(); setMode("doneNote"); }}>{t("commitments.actions.doneWithNote")}</MenuItem>
          <MenuItem icon={<Ban />} danger onSelect={() => setPage("drop")}>{t("commitments.actions.drop")}</MenuItem>
        </>
      ) : page === "snooze" ? (
        snoozes.map((s) => (
          <MenuItem key={s.key} hint={formatDate(s.at, "weekday", { locale, timeZone: tz, now })} onSelect={() => { close(); void run({ action: "snooze", until: s.at.toISOString() }); }}>
            {t(`commitments.actions.${s.key === "tomorrow" ? "snoozeTomorrow" : s.key === "in3" ? "snoozeIn3" : "snoozeNextWeek"}`)}
          </MenuItem>
        ))
      ) : page === "reassign" ? (
        <div className="max-h-72 overflow-y-auto">
          {everyone.map((p) => (
            <MenuItem key={p.id} disabled={owners.has(p.id) && owners.size === 1} icon={<Avatar id={p.id} name={p.label} size={18} />}
              onSelect={() => { close(); void run({ action: "reassign", personId: p.id }); }}>{p.label}</MenuItem>
          ))}
        </div>
      ) : (
        DROP_REASONS.map((r) => <MenuItem key={r} onSelect={() => { close(); void run({ action: "cancel", reason: r }); }}>{t(`commitments.drop.${r}`)}</MenuItem>)
      )}
    </Pop>
  );
}

function localDate(iso: string | null, tz: string): string {
  return iso ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : "";
}

function EditForm({ c, tz, busy, onCancel, onSave }: { c: CommitmentView; tz: string; busy: boolean; onCancel: () => void; onSave: (a: Action) => void }) {
  const t = useT();
  const [label, setLabel] = useState(c.label);
  const [due, setDue] = useState(localDate(c.props.dueAt, tz));
  const [amount, setAmount] = useState(c.props.amount ? String(c.props.amount.value) : "");
  const [consequence, setConsequence] = useState(c.props.consequence ?? "");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const a: Extract<Action, { action: "edit" }> = { action: "edit" };
    if (label.trim() && label.trim() !== c.label) a.label = label.trim();
    if (due !== localDate(c.props.dueAt, tz)) {
      // Keep the time of day it had (a deadline at 23:59 stays one), else noon.
      const time = c.props.dueAt ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(c.props.dueAt)) : "12:00";
      a.dueAt = due ? new Date(`${due}T${time}`).toISOString() : null;
    }
    const n = amount.trim() ? Number(amount.replace(/\./g, "").replace(",", ".")) : null;
    if (amount.trim() && (n === null || !Number.isFinite(n))) return;
    if ((n ?? null) !== (c.props.amount?.value ?? null)) a.amount = n === null ? null : { value: n, currency: c.props.amount?.currency ?? "DKK" };
    if (consequence.trim() !== (c.props.consequence ?? "")) a.consequence = consequence.trim() || null;
    if (Object.keys(a).length === 1) { onCancel(); return; }
    onSave(a);
  };
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-lg bg-surface-2/60 p-3 sm:grid-cols-2" aria-label={t("commitments.actions.editTitle")}>
      <Field label={t("commitments.actions.labelLabel")} className="sm:col-span-2"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} required /></Field>
      <Field label={t("commitments.actions.dueLabel")}><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <Field label={t("commitments.actions.amountLabel")}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label={t("commitments.actions.consequenceLabel")} className="sm:col-span-2"><Input value={consequence} onChange={(e) => setConsequence(e.target.value)} maxLength={500} /></Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy}>{t("commitments.actions.save")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("commitments.actions.cancel")}</Button>
      </div>
    </form>
  );
}

function DoneNoteForm({ busy, onCancel, onSave }: { busy: boolean; onCancel: () => void; onSave: (note: string) => void }) {
  const t = useT();
  const [note, setNote] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(note.trim()); }} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-surface-2/60 p-3">
      <Field label={t("commitments.actions.note")} className="min-w-0 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("commitments.actions.notePlaceholder")} maxLength={500} autoFocus /></Field>
      <Button type="submit" size="sm" disabled={busy}><Check aria-hidden className="size-4" />{t("commitments.actions.done")}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("commitments.actions.cancel")}</Button>
    </form>
  );
}

