"use client";
import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { CalendarClock, Pencil, Plus, Trash2, X } from "lucide-react";
import { clsx } from "clsx";
import { Button, Card, EmptyState, Input, NodeChip, Textarea } from "@/components/ui";
import type { EventItem, ReminderDTO, Section } from "@/lib/briefs";
import { buildAgenda } from "@/lib/briefs/agenda";
import { addDaysInZone, calendarDayDiff, formatShortDay, formatTime, formatWhen, fromLocalInputValue, hasTimeOfDay, toLocalInputValue } from "@/lib/briefs/dates";
import { hrefs, SectionError } from "./section";

type Person = { personNodeId: string; name: string };

async function send(url: string, method: string, body?: unknown): Promise<{ reminder?: ReminderDTO }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("We couldn't reach My Graph. Check your connection and try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { reminder?: ReminderDTO; error?: string };
  if (!res.ok) throw new Error(json.error ?? "That didn't work. Please try again.");
  return json;
}

function defaultDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return toLocalInputValue(d);
}

/** "Coming up": the next two weeks of events and reminders, with reminder check-off, snooze, edit and add. */
export function ComingUp({ tz, nowIso, events, reminders: initialReminders, people, horizonDays }: {
  tz: string; nowIso: string; events: Section<EventItem[]>; reminders: Section<ReminderDTO[]>; people: Person[]; horizonDays: number;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [reminders, setReminders] = useState<ReminderDTO[]>(initialReminders.ok ? initialReminders.data : []);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const agenda = useMemo(
    () => buildAgenda(events.ok ? events.data : [], reminders, now, tz),
    [events, reminders, now, tz],
  );

  const busy = (id: string, on: boolean) => setPending((p) => {
    const n = new Set(p);
    if (on) n.add(id); else n.delete(id);
    return n;
  });

  /** Optimistic update: apply locally, send, then take the server's copy (or put the old one back). */
  async function change(r: ReminderDTO, patch: Partial<Pick<ReminderDTO, "done" | "dueAt" | "title">>, done: string) {
    setError(null);
    setReminders((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
    busy(r.id, true);
    try {
      const { reminder } = await send(`/api/reminders/${r.id}`, "PATCH", patch);
      if (reminder) setReminders((rs) => rs.map((x) => (x.id === r.id ? reminder : x)));
      setStatus(done);
    } catch (err) {
      setReminders((rs) => rs.map((x) => (x.id === r.id ? r : x)));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy(r.id, false);
    }
  }

  async function remove(r: ReminderDTO) {
    setError(null);
    setReminders((rs) => rs.filter((x) => x.id !== r.id));
    setEditing(null);
    try {
      await send(`/api/reminders/${r.id}`, "DELETE");
      setStatus(`Deleted "${r.title}".`);
    } catch (err) {
      setReminders((rs) => [...rs, r]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function snooze(r: ReminderDTO, days: number) {
    const base = new Date(r.dueAt) < now ? now : new Date(r.dueAt);
    const due = addDaysInZone(base, days, tz);
    void change(r, { dueAt: due.toISOString() }, `Moved "${r.title}" to ${formatWhen(due, now, tz)}.`);
  }

  const hasAnything = agenda.length > 0;

  return (
    <div className="space-y-3">
      <p className="sr-only" aria-live="polite">{status}</p>
      {error && (
        <div role="alert" className="flex items-start justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-warn">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 text-muted hover:text-fg" aria-label="Dismiss message">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}
      {!events.ok && <SectionError what="events from your timeline" />}
      {!initialReminders.ok && <SectionError what="reminders" />}

      {!hasAnything && events.ok && initialReminders.ok && (
        <EmptyState title={`Nothing in the next ${horizonDays} days`}>
          Upload a school letter or invitation and the dates in it will show up here. Or add a reminder below.
        </EmptyState>
      )}

      {agenda.map((group) => (
        <Card key={group.bucket} className="p-0">
          <h3 className={clsx("border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-wide", group.bucket === "overdue" ? "text-warn" : "text-muted")}>
            {group.label}
          </h3>
          <ul className="divide-y divide-line">
            {group.items.map((item) => item.kind === "event" ? (
              <EventRow key={item.key} e={item.event} now={now} tz={tz} />
            ) : (
              <ReminderRow
                key={item.key}
                r={item.reminder}
                now={now}
                tz={tz}
                overdue={group.bucket === "overdue"}
                pending={pending.has(item.reminder.id)}
                editing={editing === item.reminder.id}
                onEdit={(on) => setEditing(on ? item.reminder.id : null)}
                onToggle={() => change(item.reminder, { done: !item.reminder.done },
                  item.reminder.done ? `"${item.reminder.title}" is open again.` : `Marked "${item.reminder.title}" as done.`)}
                onSnooze={(d) => snooze(item.reminder, d)}
                onSave={(patch) => {
                  setEditing(null);
                  void change(item.reminder, patch, `Saved "${patch.title ?? item.reminder.title}".`);
                }}
                onDelete={() => remove(item.reminder)}
              />
            ))}
          </ul>
        </Card>
      ))}

      <AddReminder people={people} onAdded={(r) => { setReminders((rs) => [...rs, r]); setStatus(`Added "${r.title}".`); }} />
    </div>
  );
}

function EventRow({ e, now, tz }: { e: EventItem; now: Date; tz: string }) {
  const start = new Date(e.startAt);
  const timed = hasTimeOfDay(start, e.timePrecision, tz);
  const startedBefore = calendarDayDiff(start, now, tz) < 0;
  return (
    <li className="flex min-w-0 gap-3 px-4 py-2.5 text-sm">
      <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-muted">{timed && !startedBefore ? formatTime(start, tz) : "All day"}</span>
      <div className="min-w-0 flex-1">
        <Link href={hrefs.node(e.id)} className="font-medium hover:underline">{e.label}</Link>
        {startedBefore && <span className="text-xs text-muted"> · since {formatShortDay(start, tz)}</span>}
        {e.children.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {e.children.map((c) => <NodeChip key={c.userId} type="person" label={c.name} />)}
          </div>
        )}
      </div>
      <span className="shrink-0 self-start rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">Event</span>
    </li>
  );
}

function ReminderRow({ r, now, tz, overdue, pending, editing, onEdit, onToggle, onSnooze, onSave, onDelete }: {
  r: ReminderDTO; now: Date; tz: string; overdue: boolean; pending: boolean; editing: boolean;
  onEdit: (on: boolean) => void; onToggle: () => void; onSnooze: (days: number) => void;
  onSave: (patch: { title?: string; dueAt?: string }) => void; onDelete: () => void;
}) {
  const due = new Date(r.dueAt);
  const checkboxId = `rem-${r.id}`;
  return (
    <li className="px-4 py-2.5 text-sm">
      <div className="flex min-w-0 items-start gap-3">
        <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-muted">{formatTime(due, tz)}</span>
        <input
          id={checkboxId}
          type="checkbox"
          checked={r.done}
          onChange={onToggle}
          disabled={pending}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={checkboxId} className={clsx("cursor-pointer font-medium", r.done && "text-muted line-through")}>{r.title}</label>
          {overdue && !r.done && <span className="text-xs text-warn"> · was due {formatWhen(due, now, tz)}</span>}
          {r.detail && <p className="mt-0.5 text-xs text-muted">{r.detail}</p>}
          {r.aboutNodeId && r.aboutLabel && (
            <div className="mt-1"><NodeChip type="person" label={r.aboutLabel} href={hrefs.node(r.aboutNodeId)} /></div>
          )}
          {!r.done && !editing && (
            <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label={`Snooze or edit "${r.title}"`}>
              <SmallButton onClick={() => onSnooze(1)} disabled={pending} label={`Snooze "${r.title}" by one day`}>+1 day</SmallButton>
              <SmallButton onClick={() => onSnooze(7)} disabled={pending} label={`Snooze "${r.title}" by one week`}>+1 week</SmallButton>
              <SmallButton onClick={() => onEdit(true)} disabled={pending} label={`Edit "${r.title}"`}>
                <Pencil aria-hidden className="size-3" />Edit
              </SmallButton>
            </div>
          )}
        </div>
        <span className="shrink-0 self-start rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">Reminder</span>
      </div>
      {editing && <EditReminder r={r} onCancel={() => onEdit(false)} onSave={onSave} onDelete={onDelete} />}
    </li>
  );
}

function SmallButton({ children, label, ...p }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" {...p} aria-label={label}
      className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
      {children}
    </button>
  );
}

function EditReminder({ r, onCancel, onSave, onDelete }: {
  r: ReminderDTO; onCancel: () => void; onSave: (patch: { title?: string; dueAt?: string }) => void; onDelete: () => void;
}) {
  const [title, setTitle] = useState(r.title);
  const [due, setDue] = useState(() => toLocalInputValue(new Date(r.dueAt)));
  const [problem, setProblem] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    const d = fromLocalInputValue(due);
    if (!t) return setProblem("Give the reminder a title.");
    if (!d) return setProblem("Pick a date and time.");
    const patch: { title?: string; dueAt?: string } = {};
    if (t !== r.title) patch.title = t;
    if (d.getTime() !== new Date(r.dueAt).getTime()) patch.dueAt = d.toISOString();
    if (!patch.title && !patch.dueAt) return onCancel();
    onSave(patch);
  }

  return (
    <form onSubmit={submit} className="mt-2 grid gap-2 rounded-md bg-surface-2 p-3 sm:grid-cols-[1fr_auto]" aria-label={`Edit "${r.title}"`}>
      <label className="text-xs text-muted">Title
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="mt-1" autoFocus />
      </label>
      <label className="text-xs text-muted">Due
        <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1" required />
      </label>
      {problem && <p role="alert" className="text-xs text-warn sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap justify-between gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDelete} className="text-danger"><Trash2 aria-hidden className="size-4" />Delete</Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </div>
    </form>
  );
}

function AddReminder({ people, onAdded }: { people: Person[]; onAdded: (r: ReminderDTO) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [about, setAbout] = useState("");
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function start() {
    setDue(defaultDue());
    setProblem(null);
    setOpen(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    const d = fromLocalInputValue(due);
    if (!t) return setProblem("Give the reminder a title.");
    if (!d) return setProblem("Pick a date and time.");
    setSaving(true);
    setProblem(null);
    try {
      const { reminder } = await send("/api/reminders", "POST", {
        title: t, dueAt: d.toISOString(), detail: detail.trim() || null, aboutNodeId: about || null,
      });
      if (reminder) onAdded(reminder);
      setTitle(""); setDetail(""); setAbout(""); setOpen(false);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={start}><Plus aria-hidden className="size-4" />Add reminder</Button>
    );
  }

  return (
    <Card>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-labelledby="add-reminder-title">
        <h3 id="add-reminder-title" className="flex items-center gap-2 text-sm font-semibold sm:col-span-2">
          <CalendarClock aria-hidden className="size-4 text-accent" />New reminder
        </h3>
        <label className="text-xs text-muted sm:col-span-2">What needs doing?
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Sign the field trip form" className="mt-1" autoFocus required />
        </label>
        <label className="text-xs text-muted">When
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1" required />
        </label>
        <label className="text-xs text-muted">About
          <select value={about} onChange={(e) => setAbout(e.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg">
            <option value="">No one in particular</option>
            {people.map((p) => <option key={p.personNodeId} value={p.personNodeId}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted sm:col-span-2">Details (optional)
          <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} rows={2} className="mt-1" placeholder="Pack lunch and rain gear" />
        </label>
        {problem && <p role="alert" className="text-sm text-warn sm:col-span-2">{problem}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button type="submit" disabled={saving} aria-busy={saving}>{saving ? "Adding…" : "Add reminder"}</Button>
        </div>
      </form>
    </Card>
  );
}
