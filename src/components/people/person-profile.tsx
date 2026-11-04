"use client";
import Link from "next/link";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CalendarDays, FileText, MessageCircle, Pencil, Phone, Plus, Users } from "lucide-react";
import { clsx } from "clsx";
import { Badge, Button, CitationChip, Field, IconButton, Input, NodeChip, PersonChip, Select, Textarea } from "@/components/ui";
import { personStyle } from "@/lib/ui/person-color";
import { CIRCLE_LABELS, type Circle } from "@/lib/meta/types";
import { normaliseCircle, WELLBEING_WORDS } from "@/lib/people/circles";
import { VISIBILITY_LABELS, type Citation, type FeedItem, type PersonProfile } from "@/lib/people/types";
import { AttributeField, formatAttr } from "./attribute-field";
import { PersonAvatar, WellbeingWord } from "./avatar";
import { ago, api, compactDate, dayLabel, fieldErrors, inDays, shortDate, When, type FieldErrors } from "./format";
import { relationOptions } from "./relation-options";
import { WellbeingChart } from "./wellbeing-chart";
import { MemoryPanel } from "@/components/memory/memory-panel";

const EASE = [0.22, 1, 0.36, 1] as const;

export function PersonProfileView({ initial }: { initial: PersonProfile }) {
  const [profile, setProfile] = useState(initial);
  const id = profile.person.id;
  const reload = async () => setProfile(await api<PersonProfile>(`/api/people/${id}`));
  const canWrite = profile.viewer.role !== "guest";

  return (
    <div style={personStyle(id) as CSSProperties}>
      <Link href="/people" className="mb-5 inline-flex items-center gap-1 rounded text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />People
      </Link>
      <Header profile={profile} onSaved={setProfile} />
      <div className="mt-10 grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-10">
          <Block title="How they’ve been">
            <div className="rounded-lg bg-surface p-4 sm:p-5">
              <WellbeingChart personId={id} observations={profile.observations} />
              {canWrite && <CheckIn personId={id} name={profile.person.label} isSelf={profile.person.isViewer} onSaved={reload} />}
            </div>
          </Block>
          <ContactLog profile={profile} onSaved={reload} />
          <ActivityFeed items={profile.feed} />
        </div>
        <div className="min-w-0 space-y-10">
          <Details profile={profile} onSaved={setProfile} />
          <Relationships profile={profile} onSaved={reload} />
          <MemoryPanel aboutNodeId={id} aboutName={profile.person.label.split(" ")[0]} />
          <Milestones profile={profile} onSaved={reload} />
          {profile.provenance.length > 0 && (
            <Block title="Where this comes from">
              <div className="flex flex-wrap gap-1.5">{profile.provenance.map((c, i) => <Cite key={i} c={c} n={i + 1} />)}</div>
              <Link href={`/node/${id}`} className="mt-3 inline-block text-sm text-accent hover:underline">Open in the graph</Link>
            </Block>
          )}
        </div>
      </div>
    </div>
  );
}

/** A titled block on the ground: heading, optional action, content. */
function Block({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id} aria-label={id ? undefined : title} className="min-w-0">
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function Cite({ c, n }: { c: Citation; n?: number }) {
  const detail = c.detail && ISO_DAY.test(c.detail) ? compactDate(`${c.detail}T12:00:00`) : c.detail;
  return <CitationChip n={n} title={c.title} detail={detail} confidence={c.confidence} href={c.href || undefined} />;
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
  const cancel = () => { setEditing(false); setLabel(p.label); setKind(p.kind ?? ""); setVisibility(p.visibility); setError(null); };

  return (
    <header>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <PersonAvatar id={p.id} label={p.label} size={72} score={latest?.score} className="[--ring-bg:var(--bg)]" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">
            {p.label}{p.isViewer && <span className="ml-2 text-lg font-normal text-muted">you</span>}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted">
            {p.relation && <span className="text-fg">{p.relation.label}</span>}
            {p.kindLabel && (!p.relation || !p.relation.label.toLowerCase().includes(p.kindLabel.toLowerCase())) && <span>{p.kindLabel}</span>}
            {!p.relation && !p.kindLabel && !p.isViewer && <span>{CIRCLE_LABELS[circle as Circle]}</span>}
            {p.aliases.length > 0 && <span>Also called {p.aliases.join(", ")}</span>}
            {p.householdMember && !p.isViewer && <span>Member of this graph</span>}
          </p>
        </div>
        {!editing && p.canEdit && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden="true" />Edit</Button>}
      </div>

      <AnimatePresence initial={false}>
        {editing && (
          <motion.form key="edit" onSubmit={save} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <div className="mt-5 grid gap-4 rounded-lg bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_200px_200px] sm:items-end">
              <Field label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} required /></Field>
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">Not set</option>
                  {profile.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </Select>
              </Field>
              {canChangeVisibility ? (
                <Field label="Who can see them">
                  <Select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
                    {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{VISIBILITY_LABELS[v]}</option>)}
                  </Select>
                </Field>
              ) : <div />}
              <div className="flex items-center justify-end gap-2 sm:col-span-3">
                {error && <p role="alert" className="mr-auto text-sm text-danger">{error}</p>}
                <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
        <Fact label="Feeling">
          <WellbeingWord score={latest?.score} />
          {latest && <span className="block text-[13px] text-muted" suppressHydrationWarning>{ago(latest.at)}</span>}
        </Fact>
        <Fact label="Last in touch">
          <When iso={p.lastContactAt} />
          {p.contactCount90 > 0 && <span className="block text-[13px] text-muted tabular-nums">{p.contactCount90} time{p.contactCount90 === 1 ? "" : "s"} in 90 days</span>}
        </Fact>
        <Fact label="Next birthday">
          {p.nextBirthday ? (
            <span suppressHydrationWarning>{dayLabel(p.nextBirthday.date)}
              <span className="block text-[13px] text-muted">{`${inDays(p.nextBirthday.daysUntil)}${p.nextBirthday.turning !== null ? `, turns ${p.nextBirthday.turning}` : ""}`}</span>
            </span>
          ) : <span className="text-muted">Not recorded</span>}
        </Fact>
        <Fact label="Who can see them">
          {VISIBILITY_LABELS[p.visibility]}
          {p.openReminders > 0 && <span className="block text-[13px] text-muted tabular-nums">{p.openReminders} open reminder{p.openReminders === 1 ? "" : "s"}</span>}
        </Fact>
      </dl>
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
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
    <form onSubmit={save} className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 id="checkin-h" className="text-[15px] font-medium">{isSelf ? "How are you today?" : `How is ${name} today?`}</h3>
        <div role="radiogroup" aria-labelledby="checkin-h" className="inline-flex flex-wrap rounded-md bg-surface-2 p-0.5">
          {[1, 2, 3, 4, 5].map((s) => (
            <button key={s} type="button" role="radio" aria-checked={score === s} tabIndex={score === s || (score === null && s === 3) ? 0 : -1}
              onClick={() => setScore(s)} onKeyDown={(e) => onKey(e, s)}
              className={clsx("h-8 rounded-[5px] px-3 text-sm transition-colors active:scale-[0.97]",
                score === s ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg")}>
              {WELLBEING_WORDS[s]}
            </button>
          ))}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {score !== null && (
          <motion.div key="more" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="space-y-3 pt-3">
              <label htmlFor="ci-note" className="sr-only">Note</label>
              <Textarea id="ci-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What’s going on? (optional)" maxLength={4000} />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
                {SUGGESTED_TAGS.map((t) => (
                  <button key={t} type="button" aria-pressed={tags.includes(t)} onClick={() => setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))}
                    className={clsx("h-7 rounded-full px-2.5 text-[13px] transition-colors", tags.includes(t) ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>{t}</button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] text-muted">Check-ins are seen by you and the parents.</p>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => { setScore(null); setMsg(null); }}>Cancel</Button>
                  <Button type="submit" disabled={saving || !score}>{saving ? "Saving…" : "Save check-in"}</Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {msg && <p role="status" className={clsx("mt-2 text-sm", msg.ok ? "text-muted" : "text-danger")}>{msg.text}</p>}
    </form>
  );
}

/* ── Contact log ──────────────────────────────────────────────────────────────────────────────────────── */

const CONTACTS = [
  { tag: "talked", label: "Talked", icon: Phone },
  { tag: "met", label: "Met", icon: Users },
  { tag: "messaged", label: "Messaged", icon: MessageCircle },
];
const CONTACT_WORD: Record<string, string> = { talked: "Talked", met: "Met", messaged: "Messaged" };

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
    <Block title="Keeping in touch">
      {canLog && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label htmlFor="contact-note" className="sr-only">Note for this contact</label>
          <Input id="contact-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you talk about? (optional)" maxLength={4000} className="min-w-[14rem] flex-1" />
          <span className="text-sm text-muted">Today we</span>
          {CONTACTS.map(({ tag, label, icon: Icon }) => (
            <Button key={tag} type="button" variant="secondary" disabled={!!busy} onClick={() => log(tag)}>
              <Icon className="size-4" aria-hidden="true" />{busy === tag ? "Saving…" : label}
            </Button>
          ))}
          {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
        </div>
      )}
      {contacts.length > 0 ? (
        <ol className="relative">
          <AnimatePresence initial={false}>
            {contacts.map((c, i) => (
              <motion.li key={c.id} layout="position" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.22, ease: EASE }} className="grid grid-cols-[92px_16px_minmax(0,1fr)] gap-x-3">
                <time dateTime={c.at} className="pt-2 text-right text-[13px] text-muted tabular-nums" suppressHydrationWarning>{compactDate(c.at)}</time>
                <span className="relative flex justify-center" aria-hidden="true">
                  {i < contacts.length - 1 && <span className="absolute bottom-0 top-4 w-px bg-line" />}
                  <span className="relative mt-[13px] size-2 rounded-full bg-[var(--person)]" />
                </span>
                <div className="min-w-0 pb-3 pt-1.5">
                  <span className="font-medium">{CONTACT_WORD[c.tags[0] ?? ""] ?? "In touch"}</span>
                  {c.authorName && <span className="text-sm text-muted"> by {c.authorName}</span>}
                  {c.note && <p className="text-sm text-muted">{c.note}</p>}
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      ) : <p className="text-sm text-muted">No calls or visits logged yet. Log one above and it starts the timeline.</p>}
    </Block>
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
    <Block title="Details" action={p.canEdit && !editing
      ? <IconButton label="Edit details" onClick={() => { setValues(p.props); setEditing(true); }}><Pencil className="size-4" /></IconButton> : undefined}>
      {editing ? (
        <form onSubmit={save} className="space-y-3 rounded-lg bg-surface p-4" noValidate>
          <div className="grid gap-3">
            {attrs.map((a) => <AttributeField key={a.key} attr={a} value={values[a.key]} error={errors[a.key]} onChange={(v) => setValues((s) => ({ ...s, [a.key]: v }))} />)}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setEditing(false); setErrors({}); }}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save details"}</Button>
          </div>
        </form>
      ) : filled.length ? (
        <dl className="divide-y divide-line text-sm">
          {filled.map((a) => (
            <div key={a.key} className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 py-2">
              <dt className="text-muted">{a.label}</dt>
              <dd className="whitespace-pre-line break-words">
                {a.dataType === "phone" ? <a className="hover:underline" href={`tel:${String(p.props[a.key]).replace(/\s/g, "")}`}>{formatAttr(a, p.props[a.key])}</a>
                  : a.dataType === "email" ? <a className="hover:underline" href={`mailto:${p.props[a.key]}`}>{formatAttr(a, p.props[a.key])}</a>
                  : <span suppressHydrationWarning>{formatAttr(a, p.props[a.key])}</span>}
                {a.sensitive && <Badge className="ml-1.5">Parents only</Badge>}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">{p.canEdit ? "No details yet. Add a birthday, phone number or how you know them." : "No details recorded."}</p>
      )}
    </Block>
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
    <Block title="Relationships" action={profile.viewer.role !== "guest" && !adding
      ? <IconButton label="Add a relationship" onClick={() => setAdding(true)}><Plus className="size-4" /></IconButton> : undefined}>
      {profile.relationships.length === 0 && !adding && <p className="text-sm text-muted">No relationships recorded yet.</p>}
      <div className="space-y-4">
        {profile.relationships.map((g) => (
          <section key={g.category} aria-label={g.label}>
            <h3 className="mb-1.5 text-[13px] text-muted">{g.label}</h3>
            <ul className="space-y-1.5">
              {g.items.map((it) => (
                <li key={it.edgeId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  {it.toYou
                    ? <Link href={`/people/${it.other.id}`} className="font-medium hover:underline underline-offset-4">{it.toYou}</Link>
                    : <>
                      <span className="text-muted">{it.label.charAt(0).toUpperCase() + it.label.slice(1)}</span>
                      {it.other.type === "person"
                        ? <PersonChip id={it.other.id} name={it.other.label} href={`/people/${it.other.id}`} />
                        : <NodeChip type={it.other.type} label={it.other.label} href={`/node/${it.other.id}`} />}
                    </>}
                  {it.status !== "confirmed" && <Badge tone="inferred">{it.status === "inferred" ? "Guess" : "Unconfirmed"}</Badge>}
                  {it.citations.slice(0, 1).map((c, i) => c.href ? <Cite key={i} c={c} /> : null)}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {adding && (
          <motion.form key="add" onSubmit={save} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mt-4 space-y-3 rounded-lg bg-surface p-4 text-sm">
              <Field label="Who or where">
                <Select value={otherId} onChange={(e) => { setOtherId(e.target.value); setRel(""); }}>
                  <option value="">Choose…</option>
                  <option value="__new">Someone new</option>
                  {people.length > 0 && <optgroup label="People">{people.map((n) => <option key={n.id} value={n.id}>{n.isViewer ? `You (${n.label})` : n.label}</option>)}</optgroup>}
                  {places.length > 0 && <optgroup label="Places">{places.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</optgroup>}
                </Select>
              </Field>
              {otherId === "__new" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} required /></Field>
                  <Field label="Kind">
                    <Select value={newKind} onChange={(e) => setNewKind(e.target.value)}>
                      <option value="">Not set</option>
                      {profile.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              {otherId && (
                <Field label={`${p.label} is…`}>
                  <Select value={rel} onChange={(e) => setRel(e.target.value)}>
                    <option value="">Choose…</option>
                    {options.map((o) => <option key={o.value} value={o.value}>{o.phrase} {otherId === "__new" ? newName || "them" : other?.isViewer ? "you" : other?.label}</option>)}
                  </Select>
                </Field>
              )}
              {error && <p role="alert" className="text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
                <Button type="submit" disabled={saving || !rel || !otherId || (otherId === "__new" && !newName.trim())}>{saving ? "Saving…" : "Add relationship"}</Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </Block>
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
    <Block title="Milestones" action={profile.viewer.role !== "guest" && !adding
      ? <IconButton label="Add a milestone" onClick={() => setAdding(true)}><Plus className="size-4" /></IconButton> : undefined}>
      <AnimatePresence initial={false}>
        {adding && (
          <motion.form key="add" onSubmit={save} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mb-4 space-y-3 rounded-lg bg-surface p-4">
              <Field label="What happened"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rode a bike without help" required maxLength={4000} /></Field>
              <Field label="When"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
                <Button type="submit" disabled={!note.trim()}>Save milestone</Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
      {profile.milestones.length ? (
        <ol className="space-y-2.5 text-sm">
          {profile.milestones.map((m) => (
            <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
              <span className="min-w-0">{m.href ? <Link href={m.href} className="hover:underline">{m.title}</Link> : m.title}</span>
              <span className="text-[13px] text-muted tabular-nums" suppressHydrationWarning>{compactDate(m.at)}</span>
            </li>
          ))}
        </ol>
      ) : !adding && <p className="text-sm text-muted">Nothing yet. First words, first school day, learning to swim.</p>}
    </Block>
  );
}

/* ── Activity feed ────────────────────────────────────────────────────────────────────────────────────── */

const FEED_ICON = { observation: MessageCircle, event: CalendarDays, document: FileText };

function ActivityFeed({ items }: { items: FeedItem[] }) {
  const [all, setAll] = useState(false);
  const now = Date.now();
  const upcoming = items.filter((f) => new Date(f.at).getTime() > now).sort((a, b) => a.at.localeCompare(b.at));
  const past = items.filter((f) => new Date(f.at).getTime() <= now);
  const shownPast = all ? past : past.slice(0, 10);

  return (
    <Block title="Timeline">
      {items.length === 0 ? <p className="text-sm text-muted">Check-ins, events and letters about them show up here, newest first.</p> : (
        <div className="space-y-6">
          {upcoming.length > 0 && <FeedList heading="Coming up" items={upcoming} />}
          {shownPast.length > 0 && <FeedList heading={upcoming.length ? "Before" : undefined} items={shownPast} />}
        </div>
      )}
      {past.length > 10 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((a) => !a)}>{all ? "Show less" : `Show all ${past.length}`}</Button>}
    </Block>
  );
}

function FeedList({ heading, items }: { heading?: string; items: FeedItem[] }) {
  return (
    <div>
      {heading && <h3 className="mb-1 text-[13px] text-muted">{heading}</h3>}
      <ol className="divide-y divide-line">
        {items.map((f) => {
          const Icon = FEED_ICON[f.type];
          return (
            <li key={f.id} className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-4 py-3 text-sm">
              <time dateTime={f.at} className="text-[13px] text-muted tabular-nums" suppressHydrationWarning>{shortDate(f.at)}</time>
              <div className="min-w-0">
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="font-medium">{f.href ? <Link href={f.href} className="hover:underline">{f.title}</Link> : f.title}</span>
                </div>
                {f.detail && <p className="mt-0.5 whitespace-pre-line break-words pl-6 text-muted">{f.detail}</p>}
                {f.citations.some((c) => c.href) && (
                  <div className="mt-1.5 flex flex-wrap gap-1 pl-6">{f.citations.filter((c) => c.href).map((c, i) => <Cite key={i} c={c} n={i + 1} />)}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
