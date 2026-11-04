"use client";
import Link from "next/link";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CalendarDays, FileText, MessageCircle, Pencil, Phone, Plus, Users } from "lucide-react";
import { clsx } from "clsx";
import { Badge, Button, CitationChip, Field, IconButton, Input, NodeChip, PersonChip, Select, Textarea } from "@/components/ui";
import { personStyle } from "@/lib/ui/person-color";
import { getTemplate } from "@/lib/templates/templates";
import { circleIn } from "@/lib/people/circles";
import type { Citation, FeedItem, PersonProfile } from "@/lib/people/types";
import { attrName, circleName, kindName, relLabel, rolePhrase, tagName, visibilityName, wellbeingWord } from "@/lib/people/words";
import { AttributeField, formatAttr } from "./attribute-field";
import { PersonAvatar, WellbeingWord } from "./avatar";
import { api, fieldErrors, useFmt, When, type Fmt, type FieldErrors } from "./format";
import { relationOptions } from "./relation-options";
import { WellbeingChart } from "./wellbeing-chart";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { AlsoInSection } from "@/components/links/also-in";
import { HistoryCard, WhoSaidField } from "@/components/history/live";

const EASE = [0.22, 1, 0.36, 1] as const;

export function PersonProfileView({ initial }: { initial: PersonProfile }) {
  const [profile, setProfile] = useState(initial);
  const id = profile.person.id;
  const reload = async () => setProfile(await api<PersonProfile>(`/api/people/${id}`));
  const canWrite = profile.viewer.role !== "guest";
  const { t } = useFmt();
  const family = profile.graph?.family ?? true;

  return (
    <div style={personStyle(id) as CSSProperties}>
      <Link href="/people" className="mb-5 inline-flex items-center gap-1 rounded text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />{t("people.profile.back")}
      </Link>
      <Header profile={profile} onSaved={setProfile} />
      <div className="mt-10 grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-10">
          <Block title={t("people.profile.howTheyveBeen")}>
            <div className="rounded-lg bg-surface p-4 sm:p-5">
              <WellbeingChart personId={id} observations={profile.observations} />
              {canWrite && <CheckIn personId={id} name={profile.person.label} isSelf={profile.person.isViewer} family={family} onSaved={reload} />}
            </div>
          </Block>
          <ContactLog profile={profile} onSaved={reload} />
          <ActivityFeed items={profile.feed} family={family} />
        </div>
        <div className="min-w-0 space-y-10">
          <Details profile={profile} onSaved={setProfile} />
          <Relationships profile={profile} onSaved={reload} />
          <AlsoInSection nodeId={id} hrefBase="/people/" />
          <MemoryPanel title={t("people.profile.memory")} aboutNodeId={id} aboutName={profile.person.label.split(" ")[0]} graphKind={profile.graph?.template} />
          <Milestones profile={profile} onSaved={reload} />
          <WhoSaidField nodeId={id} />
          <HistoryCard subjectId={id} name={profile.person.label} />
          {profile.provenance.length > 0 && (
            <Block title={t("people.profile.whereFrom")}>
              <div className="flex flex-wrap gap-1.5">{profile.provenance.map((c, i) => <Cite key={i} c={c} n={i + 1} />)}</div>
              <Link href={`/node/${id}`} className="mt-3 inline-block text-sm text-accent hover:underline">{t("people.profile.openInGraph")}</Link>
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
/** A citation's title in the reader's language when it is a generic one ("Added by hand"). */
function citeTitle(t: Fmt["t"], c: Citation): string {
  switch (c.code) {
    case "source": return t("people.cite.source");
    case "logged_by": return c.who ? t("people.cite.loggedBy", { name: c.who }) : t("people.cite.loggedByYou");
    case "logged_by_hand": return t("people.cite.loggedByHand");
    case "by_hand": return t("people.cite.byHand");
    case "assistant": return t("people.cite.assistant");
    case "rule": return t("people.cite.rule");
    case "hidden_source": return t("people.cite.hiddenSource");
    default: return c.title;
  }
}

function Cite({ c, n }: { c: Citation; n?: number }) {
  const f = useFmt();
  const detail = c.detail && ISO_DAY.test(c.detail) ? f.compactDate(`${c.detail}T12:00:00Z`) : c.detail;
  return <CitationChip n={n} title={citeTitle(f.t, c)} detail={detail} confidence={c.confidence} href={c.href || undefined} />;
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
  const f = useFmt();
  const { t } = f;
  const latest = p.wellbeing[p.wellbeing.length - 1];
  const template = profile.graph?.template ?? "family";
  const family = profile.graph?.family ?? true;
  const circle = circleIn(getTemplate(template), p.circle);
  const canChangeVisibility = p.ownerId === profile.viewer.id;
  const relText = p.relation ? rolePhrase(t, f.locale, p.relation.role, p.relation.label) : null;
  const kindText = p.kindLabel ? kindName(t, p.kindLabel) : null;

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
            {p.label}{p.isViewer && <span className="ml-2 text-lg font-normal text-muted">{t("people.youLower")}</span>}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted">
            {relText && <span className="text-fg">{relText}</span>}
            {kindText && (!relText || !relText.toLowerCase().includes(kindText.toLowerCase())) && <span>{kindText}</span>}
            {!p.relation && !p.kindLabel && !p.isViewer && <span>{circleName(t, template, circle)}</span>}
            {p.aliases.length > 0 && <span>{t("people.profile.alsoCalled", { names: p.aliases.join(", ") })}</span>}
            {p.householdMember && !p.isViewer && <span>{t("people.memberOfGraph")}</span>}
          </p>
        </div>
        {!editing && p.canEdit && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden="true" />{t("people.profile.edit")}</Button>}
      </div>

      <AnimatePresence initial={false}>
        {editing && (
          <motion.form key="edit" onSubmit={save} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <div className="mt-5 grid gap-4 rounded-lg bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_200px_200px] sm:items-end">
              <Field label={t("people.profile.name")}><Input value={label} onChange={(e) => setLabel(e.target.value)} required /></Field>
              <Field label={t("people.profile.kind")}>
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">{t("people.profile.notSet")}</option>
                  {profile.kinds.map((k) => <option key={k.key} value={k.key}>{kindName(t, k.label)}</option>)}
                </Select>
              </Field>
              {canChangeVisibility ? (
                <Field label={t("people.profile.whoCanSee")}>
                  <Select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
                    {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{visibilityName(t, family, v)}</option>)}
                  </Select>
                </Field>
              ) : <div />}
              <div className="flex items-center justify-end gap-2 sm:col-span-3">
                {error && <p role="alert" className="mr-auto text-sm text-danger">{error}</p>}
                <Button type="button" variant="ghost" onClick={cancel}>{t("people.profile.cancel")}</Button>
                <Button type="submit" disabled={saving}>{saving ? t("people.profile.saving") : t("people.profile.save")}</Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
        <Fact label={t("people.profile.feeling")}>
          <WellbeingWord score={latest?.score} />
          {latest && <span className="block text-[13px] text-muted" suppressHydrationWarning>{f.ago(latest.at)}</span>}
        </Fact>
        <Fact label={t("people.profile.lastInTouch")}>
          <When iso={p.lastContactAt} />
          {p.contactCount90 > 0 && <span className="block text-[13px] text-muted tabular-nums">{t("people.profile.times90", { count: p.contactCount90 })}</span>}
        </Fact>
        <Fact label={t("people.profile.nextBirthday")}>
          {p.nextBirthday ? (
            <span suppressHydrationWarning>{f.dayLabel(p.nextBirthday.date)}
              <span className="block text-[13px] text-muted">{p.nextBirthday.turning !== null
                ? t("people.table.turnsIn", { when: f.inDays(p.nextBirthday.daysUntil), age: p.nextBirthday.turning }) : f.inDays(p.nextBirthday.daysUntil)}</span>
            </span>
          ) : <span className="text-muted">{t("people.profile.notRecorded")}</span>}
        </Fact>
        <Fact label={t("people.profile.whoCanSee")}>
          {visibilityName(t, family, p.visibility)}
          {p.openReminders > 0 && <span className="block text-[13px] text-muted tabular-nums">{t("people.profile.openReminders", { count: p.openReminders })}</span>}
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

/** Tags offered on a check-in (stored in English, shown translated). Outside a family graph: work-life tags. */
const SUGGESTED_TAGS = ["sleep", "school", "friends", "health", "mood", "family", "activities", "work"];
const SUGGESTED_TAGS_GRAPH = ["workload", "stress", "health", "mood", "sleep", "family", "work"];

function CheckIn({ personId, name, isSelf, family, onSaved }: { personId: string; name: string; isSelf: boolean; family: boolean; onSaved: () => Promise<void> }) {
  const { t } = useFmt();
  const suggested = family ? SUGGESTED_TAGS : SUGGESTED_TAGS_GRAPH;
  const [score, setScore] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!score) { setMsg({ ok: false, text: t("people.checkin.pickFirst") }); return; }
    setSaving(true); setMsg(null);
    try {
      await api(`/api/people/${personId}/observations`, { method: "POST", json: { kind: "wellbeing", score, note: note || null, tags } });
      setScore(null); setNote(""); setTags([]);
      setMsg({ ok: true, text: t("people.checkin.saved") });
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
        <h3 id="checkin-h" className="text-[15px] font-medium">{isSelf ? t("people.checkin.howAreYou") : t("people.checkin.howIs", { name })}</h3>
        <div role="radiogroup" aria-labelledby="checkin-h" className="inline-flex flex-wrap rounded-md bg-surface-2 p-0.5">
          {[1, 2, 3, 4, 5].map((s) => (
            <button key={s} type="button" role="radio" aria-checked={score === s} tabIndex={score === s || (score === null && s === 3) ? 0 : -1}
              onClick={() => setScore(s)} onKeyDown={(e) => onKey(e, s)}
              className={clsx("h-8 rounded-[5px] px-3 text-sm transition-colors active:scale-[0.97]",
                score === s ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg")}>
              {wellbeingWord(t, s)}
            </button>
          ))}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {score !== null && (
          <motion.div key="more" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="space-y-3 pt-3">
              <label htmlFor="ci-note" className="sr-only">{t("people.checkin.note")}</label>
              <Textarea id="ci-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("people.checkin.notePlaceholder")} maxLength={4000} />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("people.checkin.tags")}>
                {suggested.map((tag) => (
                  <button key={tag} type="button" aria-pressed={tags.includes(tag)} onClick={() => setTags((ts) => (ts.includes(tag) ? ts.filter((x) => x !== tag) : [...ts, tag]))}
                    className={clsx("h-7 rounded-full px-2.5 text-[13px] transition-colors", tags.includes(tag) ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>{tagName(t, tag)}</button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] text-muted">{t(family ? "people.checkin.seenFamily" : "people.checkin.seenGraph")}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => { setScore(null); setMsg(null); }}>{t("people.checkin.cancel")}</Button>
                  <Button type="submit" disabled={saving || !score}>{saving ? t("people.checkin.saving") : t("people.checkin.save")}</Button>
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
  { tag: "talked", icon: Phone },
  { tag: "met", icon: Users },
  { tag: "messaged", icon: MessageCircle },
];

function ContactLog({ profile, onSaved }: { profile: PersonProfile; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contacts = profile.observations.filter((o) => o.kind === "contact").slice(0, 6);
  const canLog = profile.viewer.role !== "guest";
  const f = useFmt();
  const { t } = f;

  async function log(tag: string) {
    setBusy(tag); setError(null);
    try {
      await api(`/api/people/${profile.person.id}/observations`, { method: "POST", json: { kind: "contact", tags: [tag], note: note || null } });
      setNote("");
      await onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  return (
    <Block title={t("people.contact.title")}>
      {canLog && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label htmlFor="contact-note" className="sr-only">{t("people.contact.noteLabel")}</label>
          <Input id="contact-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("people.contact.notePlaceholder")} maxLength={4000} className="min-w-[14rem] flex-1" />
          <span className="text-sm text-muted">{t("people.contact.todayWe")}</span>
          {CONTACTS.map(({ tag, icon: Icon }) => (
            <Button key={tag} type="button" variant="secondary" disabled={!!busy} onClick={() => log(tag)}>
              <Icon className="size-4" aria-hidden="true" />{busy === tag ? t("people.contact.saving") : t(`people.contact.${tag}`)}
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
                <time dateTime={c.at} className="pt-2 text-right text-[13px] text-muted tabular-nums" suppressHydrationWarning>{f.compactDate(c.at)}</time>
                <span className="relative flex justify-center" aria-hidden="true">
                  {i < contacts.length - 1 && <span className="absolute bottom-0 top-4 w-px bg-line" />}
                  <span className="relative mt-[13px] size-2 rounded-full bg-[var(--person)]" />
                </span>
                <div className="min-w-0 pb-3 pt-1.5">
                  <span className="font-medium">{["talked", "met", "messaged"].includes(c.tags[0] ?? "") ? t(`people.contact.${c.tags[0]}`) : t("people.contact.inTouch")}</span>
                  {c.authorName && <span className="text-sm text-muted"> {c.byViewer ? t("people.contact.byYou") : t("people.contact.by", { name: c.authorName })}</span>}
                  {c.note && <p className="text-sm text-muted">{c.note}</p>}
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      ) : <p className="text-sm text-muted">{t("people.contact.empty")}</p>}
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
  const f = useFmt();
  const { t } = f;
  const family = profile.graph?.family ?? true;
  const show = (a: (typeof attrs)[number]) => formatAttr(a, p.props[a.key], t, f.locale);
  const filled = attrs.filter((a) => show(a) !== "");

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
    <Block title={t("people.details.title")} action={p.canEdit && !editing
      ? <IconButton label={t("people.details.edit")} onClick={() => { setValues(p.props); setEditing(true); }}><Pencil className="size-4" /></IconButton> : undefined}>
      {editing ? (
        <form onSubmit={save} className="space-y-3 rounded-lg bg-surface p-4" noValidate>
          <div className="grid gap-3">
            {attrs.map((a) => <AttributeField key={a.key} attr={a} family={family} value={values[a.key]} error={errors[a.key]} onChange={(v) => setValues((s) => ({ ...s, [a.key]: v }))} />)}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setEditing(false); setErrors({}); }}>{t("people.details.cancel")}</Button>
            <Button type="submit" disabled={saving}>{saving ? t("people.details.saving") : t("people.details.save")}</Button>
          </div>
        </form>
      ) : filled.length ? (
        <dl className="divide-y divide-line text-sm">
          {filled.map((a) => (
            <div key={a.key} className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 py-2">
              <dt className="text-muted">{attrName(t, a.label)}</dt>
              <dd className="whitespace-pre-line break-words">
                {a.dataType === "phone" ? <a className="hover:underline" href={`tel:${String(p.props[a.key]).replace(/\s/g, "")}`}>{show(a)}</a>
                  : a.dataType === "email" ? <a className="hover:underline" href={`mailto:${p.props[a.key]}`}>{show(a)}</a>
                  : <span suppressHydrationWarning>{show(a)}</span>}
                {a.sensitive && <Badge className="ml-1.5">{t(family ? "people.field.parentsOnly" : "people.field.editorsOnly")}</Badge>}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">{p.canEdit ? t("people.details.emptyEdit") : t("people.details.empty")}</p>
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
  const f = useFmt();
  const { t } = f;

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
    <Block title={t("people.relationships.title")} action={profile.viewer.role !== "guest" && !adding
      ? <IconButton label={t("people.relationships.add")} onClick={() => setAdding(true)}><Plus className="size-4" /></IconButton> : undefined}>
      {profile.relationships.length === 0 && !adding && <p className="text-sm text-muted">{t("people.relationships.empty")}</p>}
      <div className="space-y-4">
        {profile.relationships.map((g) => (
          <section key={g.category} aria-label={t(`model.category.${g.category}`, undefined, g.label)}>
            <h3 className="mb-1.5 text-[13px] text-muted">{t(`model.category.${g.category}`, undefined, g.label)}</h3>
            <ul className="space-y-1.5">
              {g.items.map((it) => (
                <li key={it.edgeId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  {it.toYou
                    ? <Link href={`/people/${it.other.id}`} className="font-medium hover:underline underline-offset-4">{rolePhrase(t, f.locale, it.toYouRole, it.toYou)}</Link>
                    : <>
                      <span className="text-muted">{((l) => l.charAt(0).toUpperCase() + l.slice(1))(relLabel(t, it.label))}</span>
                      {it.other.type === "person"
                        ? <PersonChip id={it.other.id} name={it.other.label} href={`/people/${it.other.id}`} />
                        : <NodeChip type={it.other.type} label={it.other.label} href={`/node/${it.other.id}`} />}
                    </>}
                  {it.status !== "confirmed" && <Badge tone="inferred">{t(it.status === "inferred" ? "people.relationships.guess" : "people.relationships.unconfirmed")}</Badge>}
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
              <Field label={t("people.relationships.whoOrWhere")}>
                <Select value={otherId} onChange={(e) => { setOtherId(e.target.value); setRel(""); }}>
                  <option value="">{t("people.relationships.choose")}</option>
                  <option value="__new">{t("people.relationships.someoneNew")}</option>
                  {people.length > 0 && <optgroup label={t("people.relationships.people")}>{people.map((n) => <option key={n.id} value={n.id}>{n.isViewer ? t("people.relationships.youNamed", { name: n.label }) : n.label}</option>)}</optgroup>}
                  {places.length > 0 && <optgroup label={t("people.relationships.places")}>{places.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</optgroup>}
                </Select>
              </Field>
              {otherId === "__new" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("people.relationships.name")}><Input value={newName} onChange={(e) => setNewName(e.target.value)} required /></Field>
                  <Field label={t("people.relationships.kind")}>
                    <Select value={newKind} onChange={(e) => setNewKind(e.target.value)}>
                      <option value="">{t("people.relationships.notSet")}</option>
                      {profile.kinds.map((k) => <option key={k.key} value={k.key}>{kindName(t, k.label)}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              {otherId && (
                <Field label={t("people.relationships.isWhat", { name: p.label })}>
                  <Select value={rel} onChange={(e) => setRel(e.target.value)}>
                    <option value="">{t("people.relationships.choose")}</option>
                    {options.map((o) => <option key={o.value} value={o.value}>{relLabel(t, o.phrase)} {otherId === "__new" ? newName || t("people.relationships.them") : other?.isViewer ? t("people.youLower") : other?.label}</option>)}
                  </Select>
                </Field>
              )}
              {error && <p role="alert" className="text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>{t("people.relationships.cancel")}</Button>
                <Button type="submit" disabled={saving || !rel || !otherId || (otherId === "__new" && !newName.trim())}>{saving ? t("people.relationships.saving") : t("people.relationships.save")}</Button>
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
  const f = useFmt();
  const { t } = f;
  const family = profile.graph?.family ?? true;

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
    <Block title={t("people.milestones.title")} action={profile.viewer.role !== "guest" && !adding
      ? <IconButton label={t("people.milestones.add")} onClick={() => setAdding(true)}><Plus className="size-4" /></IconButton> : undefined}>
      <AnimatePresence initial={false}>
        {adding && (
          <motion.form key="add" onSubmit={save} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mb-4 space-y-3 rounded-lg bg-surface p-4">
              <Field label={t("people.milestones.what")}><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t(family ? "people.milestones.placeholderFamily" : "people.milestones.placeholderGraph")} required maxLength={4000} /></Field>
              <Field label={t("people.milestones.when")}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>{t("people.milestones.cancel")}</Button>
                <Button type="submit" disabled={!note.trim()}>{t("people.milestones.save")}</Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
      {profile.milestones.length ? (
        <ol className="space-y-2.5 text-sm">
          {profile.milestones.map((m) => (
            <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
              <span className="min-w-0">{m.href ? <Link href={m.href} className="hover:underline">{m.title}</Link> : m.untitled ? t("people.milestones.untitled") : m.title}</span>
              <span className="text-[13px] text-muted tabular-nums" suppressHydrationWarning>{f.compactDate(m.at)}</span>
            </li>
          ))}
        </ol>
      ) : !adding && <p className="text-sm text-muted">{t(family ? "people.milestones.emptyFamily" : "people.milestones.emptyGraph")}</p>}
    </Block>
  );
}

/* ── Activity feed ────────────────────────────────────────────────────────────────────────────────────── */

const FEED_ICON = { observation: MessageCircle, event: CalendarDays, document: FileText };

function ActivityFeed({ items, family }: { items: FeedItem[]; family: boolean }) {
  const [all, setAll] = useState(false);
  const { t } = useFmt();
  const now = Date.now();
  const upcoming = items.filter((f) => new Date(f.at).getTime() > now).sort((a, b) => a.at.localeCompare(b.at));
  const past = items.filter((f) => new Date(f.at).getTime() <= now);
  const shownPast = all ? past : past.slice(0, 10);

  return (
    <Block title={t("people.feed.title")}>
      {items.length === 0 ? <p className="text-sm text-muted">{t(family ? "people.feed.emptyFamily" : "people.feed.emptyGraph")}</p> : (
        <div className="space-y-6">
          {upcoming.length > 0 && <FeedList heading={t("people.feed.comingUp")} items={upcoming} />}
          {shownPast.length > 0 && <FeedList heading={upcoming.length ? t("people.feed.before") : undefined} items={shownPast} />}
        </div>
      )}
      {past.length > 10 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((a) => !a)}>{all ? t("people.feed.showLess") : t("people.feed.showAll", { count: past.length })}</Button>}
    </Block>
  );
}

/** A feed item's title and detail in the reader's language (observations and document links are worded here). */
function feedText(t: Fmt["t"], f: FeedItem): { title: string; detail: string | null } {
  if (f.type === "observation") {
    const title = f.observationKind === "wellbeing" ? (f.score ? t("people.feed.checkInScore", { word: wellbeingWord(t, f.score) }) : t("people.feed.checkIn"))
      : f.observationKind === "contact" ? t(f.tags?.includes("met") ? "people.feed.met" : f.tags?.includes("messaged") ? "people.feed.messaged" : f.tags?.includes("talked") ? "people.feed.talked" : "people.feed.inTouch")
        : f.observationKind === "milestone" ? t("people.feed.milestone") : f.observationKind === "health" ? t("people.feed.health") : f.observationKind ? t("people.feed.note") : f.title;
    return { title, detail: f.detail };
  }
  if (f.type === "document" && f.docRelation) return { title: f.title, detail: t(f.docRelation === "about" ? "people.feed.about" : "people.feed.mentions") };
  return { title: f.title, detail: f.detail };
}

function FeedList({ heading, items }: { heading?: string; items: FeedItem[] }) {
  const fm = useFmt();
  return (
    <div>
      {heading && <h3 className="mb-1 text-[13px] text-muted">{heading}</h3>}
      <ol className="divide-y divide-line">
        {items.map((f) => {
          const Icon = FEED_ICON[f.type];
          const tx = feedText(fm.t, f);
          return (
            <li key={f.id} className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-4 py-3 text-sm">
              <time dateTime={f.at} className="text-[13px] text-muted tabular-nums" suppressHydrationWarning>{fm.shortDate(f.at)}</time>
              <div className="min-w-0">
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="font-medium">{f.href ? <Link href={f.href} className="hover:underline">{tx.title}</Link> : tx.title}</span>
                </div>
                {tx.detail && <p className="mt-0.5 whitespace-pre-line break-words pl-6 text-muted">{tx.detail}</p>}
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
