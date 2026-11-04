"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { format } from "date-fns";
import { ArrowLeft, Check, Copy, EyeOff, Mail, Plus, X } from "lucide-react";
import { DEFAULT_HUES } from "@/lib/graphs/pure";
import { Avatar, Button, buttonClass, Field, IconButton, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { GraphDot, MemberStack } from "./bits";
import {
  firstName, GRAPH_PALETTE, graphStyle, groupGraphs, KIND_LABEL, others, ownerOf, ROLE_LABEL, sharingLine, whoSeesWhat,
  type GraphRole, type GraphView,
} from "./describe";
import { graphApi, switchGraph } from "./client-api";

export type DetailMember = { userId: string; name: string; email: string | null; role: GraphRole; isYou: boolean; addedAt: string; colorId: string };
export type DetailInvite = { id: string; email: string; role: GraphRole; expiresAt: string };
export type SelectedDetail = { id: string; members: DetailMember[]; invites: DetailInvite[] };

type MakeableKind = "shared" | "personal" | "work" | "other";
const EASE = [0.22, 1, 0.36, 1] as const;
const day = (iso: string) => format(new Date(iso), "EEE d MMM");

/** The Graphs page: your graphs at left, the chosen one (or the new-graph form) at right. */
export function GraphsManager({ graphs, youId, canCreate, creating, explicit, selectedId, detail, focusInvite }: {
  graphs: GraphView[]; youId: string; canCreate: boolean; creating: boolean; explicit: boolean;
  selectedId: string | null; detail: SelectedDetail | null; focusInvite: boolean;
}) {
  const { mine, shared } = groupGraphs(graphs);
  const selected = graphs.find((g) => g.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        title="Graphs"
        lead="Keep separate graphs for the family, for work, or for someone special. Share one and they see that graph, and nothing from the others."
        actions={canCreate && !creating ? <Link href="/graphs?new=1" className={buttonClass("primary")}><Plus size={16} aria-hidden /> New graph</Link> : undefined}
      />

      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[300px_minmax(0,1fr)]">
        <nav aria-label="Your graphs" className={clsx("min-w-0", explicit && "hidden lg:block")}>
          <GraphList title="Mine" graphs={mine} youId={youId} selectedId={creating ? null : selectedId} />
          {shared.length > 0 && <GraphList title="Shared with me" graphs={shared} youId={youId} selectedId={creating ? null : selectedId} className="mt-6" />}
          {canCreate && (
            <Link href="/graphs?new=1" aria-current={creating ? "page" : undefined}
              className={clsx("mt-2 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[15px] transition-colors",
                creating ? "bg-surface font-medium" : "text-muted hover:bg-surface-2/70 hover:text-fg")}>
              <span className="flex size-[22px] items-center justify-center"><Plus size={16} aria-hidden /></span> New graph
            </Link>
          )}
        </nav>

        <div className={clsx("min-w-0", !explicit && "hidden lg:block")}>
          {explicit && (
            <Link href="/graphs" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg lg:hidden">
              <ArrowLeft size={15} aria-hidden /> All graphs
            </Link>
          )}
          {creating
            ? <CreateGraph />
            : selected && detail
              ? <GraphDetail key={selected.id} graph={selected} all={graphs} youId={youId} detail={detail} focusInvite={focusInvite} />
              : <p className="text-muted">You&apos;re not in any graph yet.</p>}
        </div>
      </div>
    </div>
  );
}

function GraphList({ title, graphs, youId, selectedId, className }: { title: string; graphs: GraphView[]; youId: string; selectedId: string | null; className?: string }) {
  if (!graphs.length) return null;
  return (
    <div className={className}>
      <h2 className="mb-1.5 px-3 text-sm font-medium text-muted">{title}</h2>
      <ul className="space-y-0.5">
        {graphs.map((g) => {
          const active = g.id === selectedId;
          return (
            <li key={g.id}>
              <Link href={`/graphs?g=${g.id}`} aria-current={active ? "page" : undefined} scroll={false}
                className={clsx("flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors",
                  active ? "bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06)]" : "hover:bg-surface-2/70")}>
                <GraphDot hue={g.color} size={11} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-center gap-2">
                    <span className={clsx("truncate text-[15px]", active && "font-medium")}>{g.name}</span>
                    {g.isCurrent && <span className="shrink-0 text-xs text-muted">Open now</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{sharingLine(g, youId) ?? "Only you"}</span>
                </span>
                {others(g, youId).length > 0 && <MemberStack people={g.members} max={g.members.length > 3 ? 2 : 3} size={22} />}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── One graph ───────────────────────────────────────────────────────────────────────────────────────── */

function GraphDetail({ graph, all, youId, detail, focusInvite }: { graph: GraphView; all: GraphView[]; youId: string; detail: SelectedDetail; focusInvite: boolean }) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = graph.myRole === "owner";
  const owner = ownerOf(graph);
  const madeBy = graph.isFamily ? "Your household's graph" : isOwner ? `You made it on ${day(graph.createdAt)}` : `${owner ? firstName(owner.name) : "Someone"} made it on ${day(graph.createdAt)}`;

  async function workHere() {
    setSwitching(true); setError(null);
    try { await switchGraph(graph.id); router.refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setSwitching(false); }
  }

  return (
    <article style={graphStyle(graph.color) as CSSProperties}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <GraphDot hue={graph.color} size={14} />
            <h2 className="truncate text-[22px]/[1.2] font-semibold tracking-[-0.015em]">{graph.name}</h2>
          </div>
          <p className="mt-1 pl-[26px] text-sm text-muted">{KIND_LABEL[graph.kind]}. {madeBy}.</p>
          {graph.description && <p className="mt-2 max-w-[60ch] pl-[26px]">{graph.description}</p>}
        </div>
        {graph.isCurrent ? (
          <span className="inline-flex h-9 items-center gap-1.5 text-sm text-muted"><Check size={15} aria-hidden /> You&apos;re working in it</span>
        ) : (
          <Button variant="secondary" onClick={workHere} disabled={switching}>{switching ? "Opening…" : "Work in this graph"}</Button>
        )}
      </header>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

      <p className="mt-6 flex max-w-[72ch] gap-3 rounded-lg bg-surface-2 px-4 py-3 text-[15px]">
        <EyeOff size={17} className="mt-[3px] shrink-0 text-muted" aria-hidden />
        <span>{whoSeesWhat(graph, all, youId)}</span>
      </p>

      <People graph={graph} detail={detail} focusInvite={focusInvite} />

      {isOwner && <Details graph={graph} />}

      {!graph.isFamily && <Ending graph={graph} youId={youId} isOwner={isOwner} ownerName={owner ? firstName(owner.name) : null} />}
    </article>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 mt-10 flex items-baseline justify-between gap-3">
      <h3 className="text-lg font-semibold tracking-[-0.01em]">{children}</h3>
      {aside}
    </div>
  );
}

/* ── People ──────────────────────────────────────────────────────────────────────────────────────────── */

function People({ graph, detail, focusInvite }: { graph: GraphView; detail: SelectedDetail; focusInvite: boolean }) {
  const router = useRouter();
  const isOwner = graph.myRole === "owner";
  const manages = isOwner && !graph.isFamily;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string; until: string } | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setError(null);
    try { await fn(); router.refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const changeRole = (m: DetailMember, role: GraphRole) => run(`role:${m.userId}`, () => graphApi(`/api/graphs/${graph.id}/members/${m.userId}`, "PATCH", { role }));
  const remove = (m: DetailMember) => run(`rm:${m.userId}`, async () => { await graphApi(`/api/graphs/${graph.id}/members/${m.userId}`, "DELETE"); setConfirmRemove(null); });
  const revoke = (i: DetailInvite) => run(`rv:${i.id}`, async () => { await graphApi(`/api/graphs/${graph.id}/invites/${i.id}`, "DELETE"); if (link?.email === i.email) setLink(null); });
  const relink = (i: DetailInvite) => run(`nl:${i.id}`, async () => {
    const r = await graphApi<{ added: boolean; inviteUrl?: string; invite?: { expiresAt: string } }>(`/api/graphs/${graph.id}/invites`, "POST", { email: i.email, role: i.role });
    if (!r.added && r.inviteUrl) setLink({ email: i.email, url: r.inviteUrl, until: r.invite?.expiresAt ?? i.expiresAt });
  });

  const count = detail.members.length;
  return (
    <section aria-labelledby="graph-people">
      <SectionTitle aside={<span className="text-sm tabular-nums text-muted">{count} {count === 1 ? "person" : "people"}</span>}>
        <span id="graph-people">People in it</span>
      </SectionTitle>

      <div className="rounded-lg bg-surface">
        <ul className="divide-y divide-line">
          <AnimatePresence initial={false}>
            {detail.members.map((m) => (
              <motion.li key={m.userId} layout="position" exit={{ opacity: 0, height: 0, transition: { duration: 0.2, ease: EASE } }}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <Avatar id={m.colorId} name={m.name} size={34} />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate font-medium">{m.name}{m.isYou && <span className="font-normal text-muted"> (you)</span>}</p>
                  {m.email && !m.isYou && <p className="mt-0.5 truncate text-sm text-muted">{m.email}</p>}
                </div>
                {manages && m.role !== "owner" ? (
                  <div className="flex items-center gap-1">
                    <Select aria-label={`What ${firstName(m.name)} can do`} value={m.role} disabled={busy !== null}
                      onChange={(e) => void changeRole(m, e.target.value as GraphRole)} className="h-8 w-auto text-sm">
                      <option value="editor">{ROLE_LABEL.editor}</option>
                      <option value="viewer">{ROLE_LABEL.viewer}</option>
                    </Select>
                    {confirmRemove === m.userId ? (
                      <span className="flex items-center gap-1">
                        <Button size="sm" variant="danger" onClick={() => void remove(m)} disabled={busy !== null}>{busy === `rm:${m.userId}` ? "Removing…" : `Remove ${firstName(m.name)}`}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>Keep</Button>
                      </span>
                    ) : (
                      <IconButton label={`Remove ${m.name} from ${graph.name}`} onClick={() => setConfirmRemove(m.userId)}><X size={16} /></IconButton>
                    )}
                  </div>
                ) : (
                  <span className="text-sm text-muted">{ROLE_LABEL[m.role]}</span>
                )}
              </motion.li>
            ))}
            {detail.invites.map((i) => (
              <motion.li key={i.id} layout="position" exit={{ opacity: 0, height: 0, transition: { duration: 0.2, ease: EASE } }}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"><Mail size={16} aria-hidden /></span>
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate font-medium">{i.email}</p>
                  <p className="mt-0.5 text-sm text-muted">Invited to {i.role === "viewer" ? "look" : "add and edit"}. The link works until {day(i.expiresAt)}.</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void relink(i)} disabled={busy !== null}>{busy === `nl:${i.id}` ? "Making…" : "New link"}</Button>
                  <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => void revoke(i)} disabled={busy !== null}>{busy === `rv:${i.id}` ? "Cancelling…" : "Cancel invite"}</Button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>

        {manages && (
          <div className="border-t border-line px-4 pb-4 pt-3.5">
            <InviteForm graph={graph} autoFocus={focusInvite} onLink={setLink} onDone={() => router.refresh()} />
            <AnimatePresence>
              {link && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
                  <InviteLink link={link} onClose={() => setLink(null)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {graph.isFamily && (
        <p className="mt-3 text-sm text-muted">
          People in the household join and leave in <Link href="/settings/family" className="text-accent hover:underline">Family settings</Link>. To share with someone outside it, make a new graph.
        </p>
      )}
      {!graph.isFamily && !isOwner && (
        <p className="mt-3 text-sm text-muted">Only {ownerOf(graph) ? firstName(ownerOf(graph)!.name) : "the owner"} can invite people to this graph.</p>
      )}
    </section>
  );
}

function InviteForm({ graph, autoFocus, onLink, onDone }: { graph: GraphView; autoFocus: boolean; onLink: (l: { email: string; url: string; until: string } | null) => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const to = email.trim();
    if (!to) { setError("Enter their email address."); return; }
    setBusy(true); setError(null); setAdded(null); onLink(null);
    try {
      const r = await graphApi<{ added: boolean; member?: { name: string }; inviteUrl?: string; invite?: { expiresAt: string } }>(
        `/api/graphs/${graph.id}/invites`, "POST", { email: to, role });
      if (r.added) setAdded(`${r.member?.name ?? to} already uses My Graph and can open ${graph.name} now.`);
      else if (r.inviteUrl) onLink({ email: to, url: r.inviteUrl, until: r.invite?.expiresAt ?? new Date(Date.now() + 14 * 864e5).toISOString() });
      setEmail("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label={`Invite someone to ${graph.name}`}>
      <label htmlFor="invite-email" className="mb-1.5 block text-sm font-medium">Invite someone</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input autoFocus={autoFocus} id="invite-email" type="email" inputMode="email" autoComplete="off" placeholder="Their email address"
          value={email} onChange={(e) => setEmail(e.target.value)} className="sm:flex-1" aria-invalid={!!error || undefined} />
        <Select aria-label="What they can do" value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")} className="sm:w-[190px]">
          <option value="editor">{ROLE_LABEL.editor}</option>
          <option value="viewer">{ROLE_LABEL.viewer}</option>
        </Select>
        <Button type="submit" disabled={busy}>{busy ? "Inviting…" : "Invite"}</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p>
        : added ? <p role="status" className="mt-2 flex items-center gap-1.5 text-sm"><Check size={15} className="text-fg" aria-hidden />{added}</p>
          : <p className="mt-2 text-sm text-muted">If they already use My Graph they&apos;re added straight away. If not, you get a link to send them.</p>}
    </form>
  );
}

function InviteLink({ link, onClose }: { link: { email: string; url: string; until: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { (document.getElementById("invite-link") as HTMLInputElement | null)?.select(); }
  }
  return (
    <div className="mt-4 rounded-md bg-accent-tint px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm">Send this link to <span className="font-medium">{link.email}</span>. It works once, until {day(link.until)}, and you won&apos;t see it again here.</p>
        <IconButton label="Hide the link" onClick={onClose} className="-mr-1.5 -mt-1 size-7"><X size={15} /></IconButton>
      </div>
      <div className="mt-2.5 flex">
        <Input id="invite-link" readOnly value={link.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-r-none text-sm" />
        <button type="button" onClick={() => void copy()}
          className={clsx(buttonClass("primary"), "rounded-l-none")}>
          {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

/* ── Name, colour, what it's for ─────────────────────────────────────────────────────────────────────── */

function Details({ graph }: { graph: GraphView }) {
  const router = useRouter();
  const [name, setName] = useState(graph.name);
  const [description, setDescription] = useState(graph.description ?? "");
  const [color, setColor] = useState(graph.color);
  const [kind, setKind] = useState<MakeableKind>(graph.kind === "family" ? "other" : graph.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== graph.name || (description.trim() || null) !== graph.description || color !== graph.color || (!graph.isFamily && kind !== graph.kind);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Give the graph a name."); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      const patch: Record<string, unknown> = {};
      if (name.trim() !== graph.name) patch.name = name.trim();
      if ((description.trim() || null) !== graph.description) patch.description = description.trim() || null;
      if (color !== graph.color) patch.color = color;
      if (!graph.isFamily && kind !== graph.kind) patch.kind = kind;
      await graphApi(`/api/graphs/${graph.id}`, "PATCH", patch);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="graph-details">
      <SectionTitle><span id="graph-details">Name and colour</span></SectionTitle>
      <form onSubmit={save} className="space-y-4 rounded-lg bg-surface p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={60} required /></Field>
          {!graph.isFamily && (
            <Field label="What it's for">
              <Select value={kind} onChange={(e) => { setKind(e.target.value as MakeableKind); setSaved(false); }}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Description" hint="Optional. A line for you and anyone you share it with.">
          <Textarea value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} rows={2} maxLength={400} placeholder="What goes in this graph" />
        </Field>
        <ColourPicker value={color} onChange={(h) => { setColor(h); setSaved(false); }} />
        <div className="flex items-center justify-end gap-3 pt-1">
          {error && <p role="alert" className="mr-auto text-sm text-danger">{error}</p>}
          {saved && !dirty && <span role="status" className="flex items-center gap-1 text-sm text-muted"><Check size={14} aria-hidden /> Saved</span>}
          <Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>
    </section>
  );
}

function ColourPicker({ value, onChange }: { value: number; onChange: (hue: number) => void }) {
  const known = GRAPH_PALETTE.some((p) => p.hue === value);
  const options = known ? GRAPH_PALETTE : [...GRAPH_PALETTE, { hue: value, name: "Current" }];
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Colour</legend>
      <div className="flex flex-wrap gap-2.5" role="radiogroup">
        {options.map((p) => {
          const on = p.hue === value;
          return (
            <label key={p.hue} title={p.name} style={graphStyle(p.hue) as CSSProperties}
              className={clsx("relative flex size-8 cursor-pointer items-center justify-center rounded-full bg-[var(--g)] transition-transform has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent active:scale-95",
                on && "ring-2 ring-[var(--g)] ring-offset-2 ring-offset-[var(--surface)]")}>
              <input type="radio" name="graph-colour" value={p.hue} checked={on} onChange={() => onChange(p.hue)} className="sr-only" aria-label={p.name} />
              {on && <Check size={15} strokeWidth={2.6} className="text-white" aria-hidden />}
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-muted">It marks the graph in the sidebar, so you always know which one you&apos;re in.</p>
    </fieldset>
  );
}

/* ── Leave or archive ────────────────────────────────────────────────────────────────────────────────── */

function Ending({ graph, youId, isOwner, ownerName }: { graph: GraphView; youId: string; isOwner: boolean; ownerName: string | null }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = graph.members.filter((m) => m.role !== "owner").map((m) => firstName(m.name));

  async function go() {
    setBusy(true); setError(null);
    try {
      if (isOwner) await graphApi(`/api/graphs/${graph.id}`, "DELETE");
      else await graphApi(`/api/graphs/${graph.id}/members/${youId}`, "DELETE");
      router.push("/graphs");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const title = isOwner ? "Archive this graph" : "Leave this graph";
  const text = isOwner
    ? `${graph.name} disappears for you${others.length ? ` and for ${others.join(" and ")}` : ""}. Nothing in it is deleted, but nobody can open it any more.`
    : `You'll stop seeing ${graph.name}. ${ownerName ?? "The owner"} can invite you again later.`;
  const action = isOwner ? `Archive ${graph.name}` : `Leave ${graph.name}`;

  return (
    <section aria-labelledby="graph-ending" className="mt-10 border-t border-line pt-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="max-w-[60ch]">
          <h3 id="graph-ending" className="font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted">{text}</p>
        </div>
        {confirm ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>Keep it</Button>
            <Button variant="danger" onClick={() => void go()} disabled={busy}>{busy ? (isOwner ? "Archiving…" : "Leaving…") : action}</Button>
          </div>
        ) : (
          <Button variant="secondary" className="text-danger" onClick={() => setConfirm(true)}>{isOwner ? "Archive…" : "Leave…"}</Button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

/* ── New graph ───────────────────────────────────────────────────────────────────────────────────────── */

const KINDS: { value: MakeableKind; label: string; hint: string }[] = [
  { value: "shared", label: "To share with someone", hint: "A graph you build for or with one person, like a partner or a friend." },
  { value: "personal", label: "Just me", hint: "Your own notes, people and plans. Nobody else sees it." },
  { value: "work", label: "Work", hint: "Colleagues, projects and dates, kept apart from home." },
  { value: "other", label: "Something else", hint: "A trip, a house project, a club." },
];

function CreateGraph() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MakeableKind>("shared");
  const [color, setColor] = useState<number>(DEFAULT_HUES.shared);
  const [picked, setPicked] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function chooseKind(k: MakeableKind) {
    setKind(k);
    if (!picked) setColor(DEFAULT_HUES[k]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Give the graph a name."); return; }
    setBusy(true); setError(null);
    try {
      const { graph } = await graphApi<{ graph: { id: string } }>("/api/graphs", "POST", { name: name.trim(), kind, color, description: description.trim() || null });
      await switchGraph(graph.id);
      router.push(`/graphs?g=${graph.id}${kind === "shared" ? "&invite=1" : ""}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="new-graph" style={graphStyle(color) as CSSProperties}>
      <div className="flex items-center gap-3">
        <GraphDot hue={color} size={14} />
        <h2 id="new-graph" className="text-[22px]/[1.2] font-semibold tracking-[-0.015em]">{name.trim() || "New graph"}</h2>
      </div>
      <p className="mt-1 max-w-[60ch] pl-[26px] text-sm text-muted">It starts empty. Nothing from your other graphs is copied in, and nobody else sees it until you share it.</p>

      <div className="mt-6 max-w-[640px] space-y-6 rounded-lg bg-surface p-4 sm:p-5">
        <Field label="Name" error={error && !name.trim() ? error : null}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="For Sara" />
        </Field>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">What is it for?</legend>
          <div className="space-y-1" role="radiogroup">
            {KINDS.map((k) => {
              const on = kind === k.value;
              return (
                <label key={k.value}
                  className={clsx("flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    on ? "bg-[var(--g-tint)]" : "hover:bg-surface-2/70")}>
                  <input type="radio" name="kind" value={k.value} checked={on} onChange={() => chooseKind(k.value)} className="sr-only" />
                  <span aria-hidden className={clsx("mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                    on ? "bg-fg ring-fg" : "ring-muted/50")}>
                    {on && <span className="size-1.5 rounded-full bg-bg" />}
                  </span>
                  <span className="leading-snug">
                    <span className="block font-medium">{k.label}</span>
                    <span className="block text-sm text-muted">{k.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <ColourPicker value={color} onChange={(h) => { setColor(h); setPicked(true); }} />

        <Field label="Description" hint="Optional. A line for you and anyone you share it with.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={400} placeholder="Places we want to go, things Sara likes" />
        </Field>

        {error && name.trim() && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Link href="/graphs" className={buttonClass("ghost")}>Cancel</Link>
          <Button type="submit" disabled={busy}>{busy ? "Making it…" : kind === "shared" ? "Make graph and invite" : "Make graph"}</Button>
        </div>
      </div>
    </form>
  );
}

