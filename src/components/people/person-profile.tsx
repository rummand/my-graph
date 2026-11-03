"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, FileText, Flag, MessageCircle, Pencil, Phone, Plus, Users } from "lucide-react";
import { clsx } from "clsx";
import { Button, Card, CitationChip, Input, NodeChip, Textarea } from "@/components/ui";
import { CIRCLE_LABELS, type Circle } from "@/lib/meta/types";
import { CIRCLE_VAR, normaliseCircle, WELLBEING_WORDS } from "@/lib/people/circles";
import { VISIBILITY_LABELS, type Citation, type FeedItem, type PersonProfile } from "@/lib/people/types";
import { AttributeField, formatAttr } from "./attribute-field";
import { Avatar, WellbeingWord } from "./avatar";
import { api, dayLabel, fieldErrors, inDays, shortDate, When, type FieldErrors } from "./format";
import { relationOptions } from "./relation-options";
import { WellbeingChart } from "./wellbeing-chart";

export function PersonProfileView({ initial }: { initial: PersonProfile }) {
  const [profile, setProfile] = useState(initial);
  const id = profile.person.id;
  const reload = async () => setProfile(await api<PersonProfile>(`/api/people/${id}`));

  return (
    <div className="space-y-6">
      <Link href="/people" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" aria-hidden="true" />People</Link>
      <Header profile={profile} onSaved={setProfile} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="min-w-0 space-y-6">
          {profile.viewer.role !== "guest" && <CheckIn personId={id} name={profile.person.label} isSelf={profile.person.isViewer} onSaved={reload} />}
          <Card>
            <h2 className="mb-3 text-sm font-semibold">How they’ve been</h2>
            <WellbeingChart observations={profile.observations} />
          </Card>
          <ContactLog profile={profile} onSaved={reload} />
          <ActivityFeed items={profile.feed} />
        </div>
        <div className="min-w-0 space-y-6">
          <Details profile={profile} onSaved={setProfile} />
          <Relationships profile={profile} onSaved={reload} />
          <Milestones profile={profile} onSaved={reload} />
          {profile.provenance.length > 0 && (
            <Card>
              <h2 className="mb-2 text-sm font-semibold">Where this comes from</h2>
              <div className="flex flex-wrap gap-1.5">{profile.provenance.map((c, i) => <Cite key={i} c={c} n={i + 1} />)}</div>
              <Link href={`/node/${id}`} className="mt-2 inline-block text-xs text-muted hover:text-fg">Open in the graph →</Link>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Cite({ c, n }: { c: Citation; n?: number }) {
  return <CitationChip n={n} title={c.title} detail={c.detail} confidence={c.confidence} href={c.href || undefined} />;
}

/* ── Header ───────────────────────────────────────────────────────────────────────────────────────────── */

function Header({ profile, onSaved }: { profile: PersonProfile; onSaved: (p: PersonProfile) => void }) {
  const p = profile.person;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(p.label);
  const [kind, setKind] = useState(p.kind ?? "");
  const [visibility, setVisibility] = useState(p.visibility);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = p.wellbeing[p.wellbeing.length - 1];
  const circle = normaliseCircle(p.circle);
  const canChangeVisibility = p.ownerId === profile.viewer.id;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      onSaved(await api<PersonProfile>(`/api/people/${p.id}`, { method: "PATCH", json: {
        label, kind: kind || null, ...(canChangeVisibility && visibility !== p.visibility ? { visibility } : {}),
      } }));
      setEditing(false);
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  return (
    <header className="flex flex-wrap items-start gap-4">
      <Avatar label={p.label} circle={p.circle} score={latest?.score} size={64} />
      {editing ? (
        <form onSubmit={save} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="h-name" className="mb-1 block text-xs text-muted">Name</label>
            <Input id="h-name" value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="h-kind" className="mb-1 block text-xs text-muted">Kind</label>
            <select id="h-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
              <option value="">Not set</option>
              {profile.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </div>
          {canChangeVisibility && (
            <div>
              <label htmlFor="h-vis" className="mb-1 block text-xs text-muted">Who can see them</label>
              <select id="h-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)} className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
                {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{VISIBILITY_LABELS[v]}</option>)}
              </select>
            </div>
          )}
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          <Button type="button" variant="ghost" onClick={() => { setEditing(false); setLabel(p.label); setKind(p.kind ?? ""); setVisibility(p.visibility); }}>Cancel</Button>
          {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{p.label}{p.isViewer && <span className="ml-2 text-base font-normal text-muted">(you)</span>}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            {p.kindLabel && <NodeChip type="person" label={p.kindLabel} />}
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CIRCLE_VAR[circle] }} />{CIRCLE_LABELS[circle as Circle]}
            </span>
            {p.relation && <span>{p.relation.label}</span>}
            <span className="text-muted">· {VISIBILITY_LABELS[p.visibility]}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            <span>Feeling: <WellbeingWord score={latest?.score} /></span>
            <span>Last in touch: <When iso={p.lastContactAt} /></span>
            {p.nextBirthday && <span suppressHydrationWarning>Birthday {dayLabel(p.nextBirthday.date)} ({inDays(p.nextBirthday.daysUntil)}{p.nextBirthday.turning !== null ? `, turns ${p.nextBirthday.turning}` : ""})</span>}
            {p.openReminders > 0 && <span>{p.openReminders} open reminder{p.openReminders === 1 ? "" : "s"}</span>}
          </div>
        </div>
      )}
      {!editing && p.canEdit && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden="true" />Edit</Button>}
    </header>
  );
}

/* ── Check-in ─────────────────────────────────────────────────────────────────────────────────────────── */

const SUGGESTED_TAGS = ["sleep", "school", "friends", "health", "mood", "family", "activities", "work"];

function CheckIn({ personId, name, isSelf, onSaved }: { personId: string; name: string; isSelf: boolean; onSaved: () => Promise<void> }) {
  const [score, setScore] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!score) { setMsg({ ok: false, text: "Pick how they are first." }); return; }
    setSaving(true); setMsg(null);
    try {
      await api(`/api/people/${personId}/observations`, { method: "POST", json: { kind: "wellbeing", score, note: note || null, tags } });
      setScore(null); setNote(""); setTags([]);
      setMsg({ ok: true, text: "Saved. Thanks for checking in." });
      await onSaved();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setSaving(false); }
  }

  const onKey = (e: React.KeyboardEvent, s: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); setScore(Math.min(5, s + 1)); (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus(); }
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); setScore(Math.max(1, s - 1)); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }
  };

  return (
    <Card>
      <form onSubmit={save} className="space-y-3">
        <h2 id="checkin-h" className="text-sm font-semibold">{isSelf ? "How are you?" : `How is ${name}?`}</h2>
        <div role="radiogroup" aria-labelledby="checkin-h" className="grid grid-cols-5 gap-1.5">
          {[1, 2, 3, 4, 5].map((s) => (
            <button key={s} type="button" role="radio" aria-checked={score === s} tabIndex={score === s || (score === null && s === 3) ? 0 : -1}
              onClick={() => setScore(s)} onKeyDown={(e) => onKey(e, s)}
              className={clsx("rounded-md border px-1 py-2 text-center text-xs sm:text-sm", score === s ? "border-accent bg-accent-tint font-medium text-accent" : "border-line hover:bg-surface-2")}>
              <span className="block text-base font-semibold">{s}</span>{WELLBEING_WORDS[s]}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor="ci-note" className="sr-only">Note</label>
          <Textarea id="ci-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's going on? (optional)" maxLength={4000} />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
          {SUGGESTED_TAGS.map((t) => (
            <button key={t} type="button" aria-pressed={tags.includes(t)} onClick={() => setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))}
              className={clsx("rounded-full border px-2.5 py-0.5 text-xs", tags.includes(t) ? "border-accent bg-accent-tint text-accent" : "border-line text-muted hover:text-fg")}>{t}</button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">Check-ins are visible to you and the parents.</p>
          <Button type="submit" disabled={saving || !score}>{saving ? "Saving…" : "Save check-in"}</Button>
        </div>
        {msg && <p role="status" className={clsx("text-sm", msg.ok ? "text-accent" : "text-danger")}>{msg.text}</p>}
      </form>
    </Card>
  );
}

/* ── Contact log ──────────────────────────────────────────────────────────────────────────────────────── */

const CONTACTS = [
  { tag: "talked", label: "Talked today", icon: Phone },
  { tag: "met", label: "Met", icon: Users },
  { tag: "messaged", label: "Messaged", icon: MessageCircle },
];

function ContactLog({ profile, onSaved }: { profile: PersonProfile; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contacts = profile.observations.filter((o) => o.kind === "contact").slice(0, 6);
  const canLog = profile.viewer.role !== "guest";

  async function log(tag: string) {
    setBusy(tag); setError(null);
    try {
      await api(`/api/people/${profile.person.id}/observations`, { method: "POST", json: { kind: "contact", tags: [tag], note: note || null } });
      setNote("");
      await onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold">Keeping in touch</h2>
      {canLog && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {CONTACTS.map(({ tag, label, icon: Icon }) => (
              <Button key={tag} type="button" variant="secondary" disabled={!!busy} onClick={() => log(tag)}>
                <Icon className="h-4 w-4" aria-hidden="true" />{busy === tag ? "Saving…" : label}
              </Button>
            ))}
          </div>
          <label htmlFor="contact-note" className="sr-only">Note for this contact</label>
          <Input id="contact-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the next one (optional)" maxLength={4000} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}
      {contacts.length > 0 ? (
        <ul className="mt-3 divide-y divide-line text-sm">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0"><span className="capitalize">{c.tags[0] ?? "In touch"}</span>{c.note && <span className="text-muted"> — {c.note}</span>}</span>
              <When iso={c.at} className="shrink-0 text-xs text-muted" />
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-muted">No contact logged yet.</p>}
    </Card>
  );
}

/* ── Details (attributes from the meta model) ─────────────────────────────────────────────────────────── */

function Details({ profile, onSaved }: { profile: PersonProfile; onSaved: (p: PersonProfile) => void }) {
  const p = profile.person;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(p.props);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const attrs = profile.attributes;
  const filled = attrs.filter((a) => formatAttr(a, p.props[a.key]) !== "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErrors({}); setError(null);
    const changed: Record<string, unknown> = {};
    for (const a of attrs) {
      const before = p.props[a.key] ?? "";
      const after = values[a.key] ?? "";
      if (String(before) !== String(after)) changed[a.key] = after === "" ? null : after;
    }
    if (Object.keys(changed).length === 0) { setEditing(false); setSaving(false); return; }
    try {
      const next = await api<PersonProfile>(`/api/people/${p.id}`, { method: "PATCH", json: { props: changed } });
      onSaved(next); setValues(next.person.props); setEditing(false);
    } catch (err) { setErrors(fieldErrors(err)); setError((err as Error).message); } finally { setSaving(false); }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Details</h2>
        {p.canEdit && !editing && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => { setValues(p.props); setEditing(true); }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</Button>}
      </div>
      {editing ? (
        <form onSubmit={save} className="space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {attrs.map((a) => <AttributeField key={a.key} attr={a} value={values[a.key]} error={errors[a.key]} onChange={(v) => setValues((s) => ({ ...s, [a.key]: v }))} />)}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setEditing(false); setErrors({}); }}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save details"}</Button>
          </div>
        </form>
      ) : filled.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {filled.map((a) => (
            <div key={a.key} className="contents">
              <dt className="text-muted">{a.label}</dt>
              <dd className="whitespace-pre-line break-words">{a.dataType === "phone" ? <a className="hover:underline" href={`tel:${String(p.props[a.key]).replace(/\s/g, "")}`}>{formatAttr(a, p.props[a.key])}</a>
                : a.dataType === "email" ? <a className="hover:underline" href={`mailto:${p.props[a.key]}`}>{formatAttr(a, p.props[a.key])}</a>
                : <span suppressHydrationWarning>{formatAttr(a, p.props[a.key])}</span>}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-sm text-muted">{p.canEdit ? "No details yet. Add a birthday, phone number or how you know them." : "No details recorded."}</p>}
    </Card>
  );
}

/* ── Relationships ────────────────────────────────────────────────────────────────────────────────────── */

function Relationships({ profile, onSaved }: { profile: PersonProfile; onSaved: () => Promise<void> }) {
  const p = profile.person;
  const [adding, setAdding] = useState(false);
  const [otherId, setOtherId] = useState("");
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("");
  const [rel, setRel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const other = profile.nodeOptions.find((n) => n.id === otherId);
  const otherType = otherId === "__new" ? "person" : other?.type ?? "person";
  const options = useMemo(() => relationOptions(profile.relationOptions, "person", otherType), [profile.relationOptions, otherType]);
  const people = profile.nodeOptions.filter((n) => n.type === "person");
  const places = profile.nodeOptions.filter((n) => n.type === "place");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!rel || !otherId) return;
    setSaving(true); setError(null);
    const [key, direction] = rel.split(":");
    try {
      await api(`/api/people/${p.id}/relations`, { method: "POST", json: {
        relation: key, direction,
        ...(otherId === "__new" ? { newPerson: { label: newName.trim(), kind: newKind || null } } : { otherId }),
      } });
      setAdding(false); setOtherId(""); setRel(""); setNewName(""); setNewKind("");
      await onSaved();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Relationships</h2>
        {profile.viewer.role !== "guest" && !adding && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add</Button>}
      </div>
      {profile.relationships.length === 0 && !adding && <p className="text-sm text-muted">No relationships recorded yet.</p>}
      <div className="space-y-3">
        {profile.relationships.map((g) => (
          <section key={g.category} aria-label={g.label}>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{g.label}</h3>
            <ul className="space-y-1 text-sm">
              {g.items.map((it) => (
                <li key={it.edgeId} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span className="text-muted">{it.label}</span>
                  <Link href={it.other.type === "person" ? `/people/${it.other.id}` : `/node/${it.other.id}`} className="font-medium hover:underline">{it.other.label}</Link>
                  {it.other.kindLabel && <span className="text-xs text-muted">({it.other.kindLabel.toLowerCase()})</span>}
                  {it.status !== "confirmed" && <span className="rounded bg-surface-2 px-1 text-[10px] text-inferred">{it.status === "inferred" ? "guess" : "unconfirmed"}</span>}
                  {it.citations.slice(0, 1).map((c, i) => c.href ? <Cite key={i} c={c} /> : null)}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {adding && (
        <form onSubmit={save} className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
          <div>
            <label htmlFor="rel-other" className="mb-1 block text-xs text-muted">Who or where</label>
            <select id="rel-other" value={otherId} onChange={(e) => { setOtherId(e.target.value); setRel(""); }} className="w-full rounded-md border border-line bg-surface px-2 py-1.5">
              <option value="">Choose…</option>
              <option value="__new">+ Someone new</option>
              {people.length > 0 && <optgroup label="People">{people.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</optgroup>}
              {places.length > 0 && <optgroup label="Places">{places.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</optgroup>}
            </select>
          </div>
          {otherId === "__new" && (
            <div className="grid grid-cols-2 gap-2">
              <div><label htmlFor="rel-new" className="mb-1 block text-xs text-muted">Name</label><Input id="rel-new" value={newName} onChange={(e) => setNewName(e.target.value)} required /></div>
              <div>
                <label htmlFor="rel-newkind" className="mb-1 block text-xs text-muted">Kind</label>
                <select id="rel-newkind" value={newKind} onChange={(e) => setNewKind(e.target.value)} className="w-full rounded-md border border-line bg-surface px-2 py-2">
                  <option value="">Not set</option>
                  {profile.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </div>
            </div>
          )}
          {otherId && (
            <div>
              <label htmlFor="rel-kind" className="mb-1 block text-xs text-muted">{p.label} is…</label>
              <select id="rel-kind" value={rel} onChange={(e) => setRel(e.target.value)} className="w-full rounded-md border border-line bg-surface px-2 py-1.5">
                <option value="">Choose…</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.phrase} {otherId === "__new" ? newName || "them" : other?.label}</option>)}
              </select>
            </div>
          )}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
            <Button type="submit" disabled={saving || !rel || !otherId || (otherId === "__new" && !newName.trim())}>{saving ? "Saving…" : "Add relationship"}</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/* ── Milestones ───────────────────────────────────────────────────────────────────────────────────────── */

function Milestones({ profile, onSaved }: { profile: PersonProfile; onSaved: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/people/${profile.person.id}/observations`, { method: "POST", json: { kind: "milestone", note, ...(date ? { at: date } : {}) } });
      setNote(""); setDate(""); setAdding(false);
      await onSaved();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Milestones</h2>
        {profile.viewer.role !== "guest" && !adding && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add</Button>}
      </div>
      {adding && (
        <form onSubmit={save} className="mb-3 space-y-2">
          <label htmlFor="ms-note" className="sr-only">Milestone</label>
          <Input id="ms-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rode a bike without support" required maxLength={4000} />
          <div className="flex items-center gap-2">
            <label htmlFor="ms-date" className="text-xs text-muted">When</label>
            <Input id="ms-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" />
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" disabled={!note.trim()}>Save</Button>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form>
      )}
      {profile.milestones.length ? (
        <ol className="space-y-1.5 text-sm">
          {profile.milestones.map((m) => (
            <li key={m.id} className="flex items-baseline gap-2">
              <Flag className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-[var(--t-event)]" aria-hidden="true" />
              <span className="min-w-0 flex-1">{m.href ? <Link href={m.href} className="hover:underline">{m.title}</Link> : m.title}</span>
              <span className="shrink-0 text-xs text-muted" suppressHydrationWarning>{shortDate(m.at)}</span>
            </li>
          ))}
        </ol>
      ) : !adding && <p className="text-sm text-muted">Nothing yet — first words, first school day, learned to swim…</p>}
    </Card>
  );
}

/* ── Activity feed ────────────────────────────────────────────────────────────────────────────────────── */

const FEED_ICON = { observation: MessageCircle, event: CalendarDays, document: FileText };

function ActivityFeed({ items }: { items: FeedItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 12);
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold">Activity</h2>
      {items.length === 0 ? <p className="text-sm text-muted">Check-ins, events and documents about them will show up here.</p> : (
        <ol className="space-y-3">
          {shown.map((f) => {
            const Icon = FEED_ICON[f.type];
            return (
              <li key={f.id} className="flex gap-3 text-sm">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-medium">{f.href ? <Link href={f.href} className="hover:underline">{f.title}</Link> : f.title}</span>
                    <When iso={f.at} mode="date" className="text-xs text-muted" />
                  </div>
                  {f.detail && <p className="mt-0.5 whitespace-pre-line break-words text-muted">{f.detail}</p>}
                  {f.citations.some((c) => c.href) && <div className="mt-1 flex flex-wrap gap-1">{f.citations.filter((c) => c.href).map((c, i) => <Cite key={i} c={c} n={i + 1} />)}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 12 && <Button variant="ghost" className="mt-2 text-xs" onClick={() => setAll((a) => !a)}>{all ? "Show less" : `Show all ${items.length}`}</Button>}
    </Card>
  );
}
