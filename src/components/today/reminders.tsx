"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { clsx } from "clsx";
import { Button, EmptyState, Field, Input, PersonChip, Select, Textarea } from "@/components/ui";
import type { ReminderDTO } from "@/lib/briefs";
import { addDaysInZone, calendarDayDiff, fromLocalInputValue, groupByBucket, toLocalInputValue } from "@/lib/briefs/dates";
import { useLocale, useT, type TFn } from "@/lib/i18n/client";
import { hrefs, SectionError, TodaySection } from "./section";
import { displayTitle, dueLabel, humanizeDates, relativeDay } from "./week";

export type Person = { personNodeId: string; name: string };
type Patch = Partial<Pick<ReminderDTO, "done" | "dueAt" | "title">>;

const EASE = [0.22, 1, 0.36, 1] as const;
/** How long a ticked reminder shows its tick before it folds away. */
const TICK_HOLD_MS = 280;

async function send(t: TFn, url: string, method: string, body?: unknown): Promise<{ reminder?: ReminderDTO }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(t("today.error.offline"));
  }
  const json = (await res.json().catch(() => ({}))) as { reminder?: ReminderDTO; error?: string };
  if (!res.ok) throw new Error(json.error ?? t("today.error.generic"));
  return json;
}

function defaultDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return toLocalInputValue(d);
}

/** Reminder state with optimistic writes; shared by the week strip and the list. */
export function useReminders(initial: ReminderDTO[], now: Date, tz: string) {
  const t = useT();
  const locale = useLocale();
  const [reminders, setReminders] = useState<ReminderDTO[]>(initial);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [ticking, setTicking] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [undo, setUndo] = useState<ReminderDTO | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const mark = (set: typeof setPending, id: string, on: boolean) => set((p) => {
    const n = new Set(p);
    if (on) n.add(id); else n.delete(id);
    return n;
  });

  /** Apply locally, send, then take the server's copy (or put the old one back). */
  async function change(r: ReminderDTO, patch: Patch, done: string) {
    setError(null);
    setReminders((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
    mark(setPending, r.id, true);
    try {
      const { reminder } = await send(t, `/api/reminders/${r.id}`, "PATCH", patch);
      if (reminder) setReminders((rs) => rs.map((x) => (x.id === r.id ? reminder : x)));
      setStatus(done);
      return true;
    } catch (err) {
      setReminders((rs) => rs.map((x) => (x.id === r.id ? r : x)));
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      mark(setPending, r.id, false);
    }
  }

  function showUndo(r: ReminderDTO | null) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(r);
    if (r) undoTimer.current = setTimeout(() => setUndo(null), 6000);
  }

  /** Tick: the box fills, holds a beat, then the row folds away and an undo appears. */
  function tick(r: ReminderDTO) {
    mark(setTicking, r.id, true);
    setTimeout(() => {
      mark(setTicking, r.id, false);
      showUndo(r);
      void change(r, { done: true }, t("today.todo.status.done", { title: r.title })).then((ok) => { if (!ok) showUndo(null); });
    }, TICK_HOLD_MS);
  }

  function reopen(r: ReminderDTO) {
    showUndo(null);
    void change({ ...r, done: true }, { done: false }, t("today.todo.status.reopened", { title: r.title }));
  }

  function snooze(r: ReminderDTO, days: number) {
    const base = new Date(r.dueAt) < now ? now : new Date(r.dueAt);
    const due = addDaysInZone(base, days, tz);
    void change(r, { dueAt: due.toISOString() }, t("today.todo.status.moved", { title: r.title, day: relativeDay(due, now, tz, locale) }));
  }

  async function remove(r: ReminderDTO) {
    setError(null);
    setReminders((rs) => rs.filter((x) => x.id !== r.id));
    try {
      await send(t, `/api/reminders/${r.id}`, "DELETE");
      setStatus(t("today.todo.status.deleted", { title: r.title }));
    } catch (err) {
      setReminders((rs) => [...rs, r]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function added(r: ReminderDTO) {
    setReminders((rs) => [...rs, r]);
    setStatus(t("today.todo.status.added", { title: r.title }));
  }

  return { reminders, pending, ticking, error, setError, status, undo, change, tick, reopen, snooze, remove, added, dismissUndo: () => showUndo(null) };
}

type Api = ReturnType<typeof useReminders>;

/** The things to do: open reminders by day, ticked off in place. */
export function RemindersList({ api, loadFailed, now, tz, people, isFamily }: { api: Api; loadFailed: boolean; now: Date; tz: string; people: Person[]; isFamily: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const open = useMemo(() => api.reminders.filter((r) => !r.done), [api.reminders]);
  const groups = useMemo(() => groupByBucket(open, (r) => new Date(r.dueAt), now, tz, locale), [open, now, tz, locale]);

  return (
    <TodaySection
      id="reminders"
      title={<>{t("today.todo.title")}{open.length > 0 && <span className="ml-2 text-sm font-normal tabular-nums text-muted">{t("today.todo.open", { count: open.length })}</span>}</>}
      action={!adding && <Button variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus aria-hidden className="size-4" />{t("today.todo.add")}</Button>}
    >
      <p className="sr-only" aria-live="polite">{api.status}</p>
      {api.error && (
        <div role="alert" className="mb-2 flex items-start justify-between gap-2 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">
          <span>{api.error}</span>
          <button type="button" onClick={() => api.setError(null)} className="shrink-0 rounded hover:text-fg" aria-label={t("today.todo.dismiss")}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}
      {loadFailed && <SectionError what={t("today.error.what.reminders")} className="mb-2" />}

      <AnimatePresence initial={false}>
        {adding && (
          <motion.div key="add" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <AddReminder people={people} isFamily={isFamily} onCancel={() => setAdding(false)} onAdded={(r) => { api.added(r); setAdding(false); }} />
          </motion.div>
        )}
      </AnimatePresence>

      {open.length === 0 && !loadFailed ? (
        !adding && (
          <EmptyState title={t("today.todo.emptyTitle")}>
            {t(isFamily ? "today.todo.emptyFamily" : "today.todo.empty")}
          </EmptyState>
        )
      ) : (
        <div className="rounded-lg bg-surface px-4 py-1">
          <AnimatePresence initial={false}>
            {groups.map((g) => (
              <motion.div key={g.bucket} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
                <h3 className={clsx("pb-1 pt-3 text-sm font-medium", g.bucket === "overdue" ? "text-warn" : "text-muted")}>{g.label}</h3>
                <ul>
                  <AnimatePresence initial={false}>
                    {g.items.map((r) => (
                      <ReminderRow
                        key={r.id}
                        r={r}
                        now={now}
                        tz={tz}
                        overdue={g.bucket === "overdue"}
                        checked={api.ticking.has(r.id)}
                        pending={api.pending.has(r.id) || api.ticking.has(r.id)}
                        editing={editing === r.id}
                        onEdit={(on) => setEditing(on ? r.id : null)}
                        onTick={() => api.tick(r)}
                        onSnooze={(d) => api.snooze(r, d)}
                        onSave={(patch) => { setEditing(null); void api.change(r, patch, t("today.todo.status.saved", { title: patch.title ?? r.title })); }}
                        onDelete={() => { setEditing(null); void api.remove(r); }}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              </motion.div>
            ))}
          </AnimatePresence>
          <div className="h-2" />
        </div>
      )}

      <AnimatePresence>
        {api.undo && (
          <motion.div
            key={api.undo.id}
            role="status"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.2, ease: EASE }}
            className="fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-sm items-center gap-3 rounded-lg bg-fg py-2 pl-4 pr-2 text-sm text-bg shadow-float lg:bottom-8"
          >
            <Check aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("today.todo.doneToast", { title: displayTitle(api.undo.title, api.undo.aboutLabel) })}</span>
            <button type="button" onClick={() => api.reopen(api.undo!)} className="rounded-md px-2.5 py-1 font-medium hover:bg-bg/15">{t("today.todo.undo")}</button>
          </motion.div>
        )}
      </AnimatePresence>
    </TodaySection>
  );
}

function ReminderRow({ r, now, tz, overdue, checked, pending, editing, onEdit, onTick, onSnooze, onSave, onDelete }: {
  r: ReminderDTO; now: Date; tz: string; overdue: boolean; checked: boolean; pending: boolean; editing: boolean;
  onEdit: (on: boolean) => void; onTick: () => void; onSnooze: (days: number) => void;
  onSave: (patch: { title?: string; dueAt?: string }) => void; onDelete: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const due = new Date(r.dueAt);
  const id = `reminder-${r.id}`;
  const title = displayTitle(r.title, r.aboutLabel);
  return (
    <motion.li
      id={id}
      layout="position"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0, transition: { height: { duration: 0.24, ease: EASE }, opacity: { duration: 0.12 } } }}
      transition={{ duration: 0.22, ease: EASE }}
      className="group scroll-mt-24 overflow-hidden [&:target>div]:bg-accent-tint"
    >
      <div className="-mx-2 flex gap-3 rounded-md px-2 py-2.5 transition-colors">
        <span className="relative mt-[3px] size-[18px] shrink-0">
          <input
            id={`${id}-box`}
            type="checkbox"
            checked={checked}
            onChange={onTick}
            disabled={pending}
            aria-label={t("today.todo.markDone", { title: r.title })}
            className="peer absolute inset-0 cursor-pointer appearance-none rounded-full shadow-[inset_0_0_0_1.5px_var(--muted)] transition-[background-color,box-shadow] duration-150 checked:bg-fg checked:shadow-[inset_0_0_0_1.5px_var(--fg)] hover:shadow-[inset_0_0_0_1.5px_var(--fg)] disabled:cursor-default"
          />
          <Check aria-hidden strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto size-[11px] scale-50 text-bg opacity-0 transition-[opacity,transform] duration-150 peer-checked:scale-100 peer-checked:opacity-100" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-x-3 sm:flex-row sm:items-baseline sm:justify-between">
            <label htmlFor={`${id}-box`} className={clsx("min-w-0 cursor-pointer font-medium transition-colors", checked && "text-muted line-through")}>{title}</label>
            <span className={clsx("shrink-0 text-sm", overdue ? "text-warn" : "text-muted")}>
              {overdue ? t("today.todo.wasDue", { day: calendarDayDiff(due, now, tz) === -1 ? t("today.day.yesterday") : relativeDay(due, now, tz, locale) }) : dueLabel(due, now, tz, locale)}
            </span>
          </div>
          {!editing && (
            <div className="mt-1 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {r.aboutNodeId && r.aboutLabel && <PersonChip id={r.aboutNodeId} name={r.aboutLabel} href={hrefs.node(r.aboutNodeId)} className="shrink-0" />}
              {r.detail && <p className="order-last w-full text-sm text-muted sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:truncate" title={humanizeDates(r.detail, tz, locale)}>{humanizeDates(r.detail, tz, locale)}</p>}
              <div role="group" aria-label={t("today.todo.snoozeOrEdit", { title: r.title })}
                className="ml-auto flex shrink-0 items-center gap-0.5 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">
                <RowAction onClick={() => onSnooze(1)} disabled={pending} label={t("today.todo.snoozeDayLabel", { title: r.title })}>{t("today.todo.snoozeDay")}</RowAction>
                <RowAction onClick={() => onSnooze(7)} disabled={pending} label={t("today.todo.snoozeWeekLabel", { title: r.title })}>{t("today.todo.snoozeWeek")}</RowAction>
                <RowAction onClick={() => onEdit(true)} disabled={pending} label={t("today.todo.editLabel", { title: r.title })}><Pencil aria-hidden className="size-3.5" /><span className="sr-only">{t("common.edit")}</span></RowAction>
              </div>
            </div>
          )}
          {editing && <EditReminder r={r} onCancel={() => onEdit(false)} onSave={onSave} onDelete={onDelete} />}
        </div>
      </div>
    </motion.li>
  );
}

function RowAction({ children, label, ...p }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" {...p} title={label}
      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-45">
      {children}
    </button>
  );
}

function EditReminder({ r, onCancel, onSave, onDelete }: {
  r: ReminderDTO; onCancel: () => void; onSave: (patch: { title?: string; dueAt?: string }) => void; onDelete: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(r.title);
  const [due, setDue] = useState(() => toLocalInputValue(new Date(r.dueAt)));
  const [problem, setProblem] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const tt = title.trim();
    const d = fromLocalInputValue(due);
    if (!tt) return setProblem(t("today.todo.needTitle"));
    if (!d) return setProblem(t("today.todo.needDate"));
    const patch: { title?: string; dueAt?: string } = {};
    if (tt !== r.title) patch.title = tt;
    if (d.getTime() !== new Date(r.dueAt).getTime()) patch.dueAt = d.toISOString();
    if (!patch.title && !patch.dueAt) return onCancel();
    onSave(patch);
  }

  return (
    <form onSubmit={submit} className="mt-2 grid gap-3 rounded-md bg-surface-2/70 p-3 sm:grid-cols-[1fr_200px]" aria-label={t("today.todo.editLabel", { title: r.title })}>
      <Field label={t("today.todo.fieldTitle")}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus /></Field>
      <Field label={t("today.todo.fieldDue")}><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} required /></Field>
      {problem && <p role="alert" className="text-sm text-warn sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap justify-between gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDelete} className="text-danger hover:text-danger"><Trash2 aria-hidden className="size-4" />{t("today.todo.delete")}</Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm">{t("common.save")}</Button>
        </div>
      </div>
    </form>
  );
}

function AddReminder({ people, isFamily, onAdded, onCancel }: { people: Person[]; isFamily: boolean; onAdded: (r: ReminderDTO) => void; onCancel: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(defaultDue);
  const [about, setAbout] = useState("");
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const tt = title.trim();
    const d = fromLocalInputValue(due);
    if (!tt) return setProblem(t("today.todo.needTitle"));
    if (!d) return setProblem(t("today.todo.needDate"));
    setSaving(true);
    setProblem(null);
    try {
      const { reminder } = await send(t, "/api/reminders", "POST", {
        title: tt, dueAt: d.toISOString(), detail: detail.trim() || null, aboutNodeId: about || null,
      });
      if (reminder) onAdded(reminder);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 grid gap-3 rounded-lg bg-surface p-4 sm:grid-cols-2" aria-label={t("today.todo.newLabel")}>
      <Field label={t("today.todo.fieldWhat")} className="sm:col-span-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={t(isFamily ? "today.todo.placeholderFamily" : "today.todo.placeholder")} autoFocus required />
      </Field>
      <Field label={t("today.todo.fieldWhen")}><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} required /></Field>
      <Field label={t("today.todo.fieldAbout")}>
        <Select value={about} onChange={(e) => setAbout(e.target.value)}>
          <option value="">{t("today.todo.noOne")}</option>
          {people.map((p) => <option key={p.personNodeId} value={p.personNodeId}>{p.name}</option>)}
        </Select>
      </Field>
      <Field label={t("today.todo.fieldDetails")} hint={t("today.todo.optional")} className="sm:col-span-2">
        <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} rows={2} placeholder={t(isFamily ? "today.todo.detailPlaceholderFamily" : "today.todo.detailPlaceholder")} />
      </Field>
      {problem && <p role="alert" className="text-sm text-warn sm:col-span-2">{problem}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>{saving ? t("today.todo.adding") : t("today.todo.add")}</Button>
      </div>
    </form>
  );
}
