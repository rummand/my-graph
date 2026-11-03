"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Check, ChevronsUpDown, Copy, Plus, UserPlus, X } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";

export type SwitcherGraph = {
  id: string; name: string; kind: string; color: number; myRole: "owner" | "editor" | "viewer";
  memberCount: number; isFamily: boolean;
};

type Member = { userId: string; name: string; email: string | null; role: string; isYou: boolean };
type Invite = { id: string; email: string; role: string; state: string };

const KIND_LABEL: Record<string, string> = { family: "Family", personal: "Just me", work: "Work", shared: "Shared", other: "Other" };
const ROLE_LABEL: Record<string, string> = { owner: "Owner", editor: "Can add and edit", viewer: "Can only look" };

export const graphColor = (hue: number) => `oklch(0.64 0.14 ${hue})`;

function Dot({ hue, size = 10 }: { hue: number; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: graphColor(hue) }} />;
}

function describe(g: SwitcherGraph) {
  if (g.isFamily) return "Your family";
  if (g.myRole !== "owner") return `Shared with you, ${g.myRole === "viewer" ? "to look at" : "to add to"}`;
  return g.memberCount > 1 ? `${KIND_LABEL[g.kind] ?? "Graph"}, shared with ${g.memberCount - 1}` : `${KIND_LABEL[g.kind] ?? "Graph"}, only you`;
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
  return data;
}

/** Which graph you're working in, with switching, making a new one, and sharing the current one. */
export function GraphSwitcher({ graphs, currentId, compact }: { graphs: SwitcherGraph[]; currentId: string; compact?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "new" | "share">("list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = graphs.find((g) => g.id === currentId) ?? graphs[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  function close() { setOpen(false); setMode("list"); setError(null); }

  /** Detail pages (/node/<id>, /wiki/<slug>, …) belong to one graph, so leave them for their section's list. */
  function afterSwitch() {
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 1 && parts[0] !== "settings") router.push(`/${parts[0]}`);
    router.refresh();
  }

  async function switchTo(id: string) {
    if (id === currentId) { close(); return; }
    setBusy(true); setError(null);
    try { await post("/api/graphs/switch", { graphId: id }); close(); afterSwitch(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function create(form: FormData) {
    setBusy(true); setError(null);
    try {
      const { graph } = await post("/api/graphs", { name: String(form.get("name") ?? "").trim(), kind: String(form.get("kind") ?? "other") });
      await post("/api/graphs/switch", { graphId: graph.id });
      close(); afterSwitch();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!current) return null;
  const canShare = current.myRole === "owner" && !current.isFamily;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={clsx("flex w-full items-center gap-2 rounded-md text-left hover:bg-surface-2", compact ? "px-2 py-1" : "px-2 py-1.5")}
      >
        <Dot hue={current.color} />
        <span className="min-w-0 flex-1 leading-tight">
          {!compact && <span className="block text-[11px] text-muted">Working in</span>}
          <span className="block truncate text-sm font-medium">{current.name}</span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-muted" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Your graphs"
          className={clsx(
            "absolute z-50 mt-1 w-[300px] max-w-[calc(100vw-32px)] rounded-lg border border-line bg-surface p-2 shadow-float",
            compact ? "right-0" : "left-0",
          )}
        >
          {mode === "list" && (
            <>
              <ul className="max-h-[50vh] overflow-y-auto">
                {graphs.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => switchTo(g.id)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface-2 disabled:opacity-60"
                    >
                      <Dot hue={g.color} />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-sm font-medium">{g.name}</span>
                        <span className="block truncate text-xs text-muted">{describe(g)}</span>
                      </span>
                      {g.id === currentId && <Check size={15} className="shrink-0 text-accent" aria-label="Current" />}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="px-2 pb-1 pt-2 text-xs text-muted">Each graph is separate. People you share one with see nothing from the others.</p>
              <div className="mt-1 flex flex-col border-t border-line pt-1">
                {canShare && (
                  <button type="button" onClick={() => setMode("share")} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2">
                    <UserPlus size={15} aria-hidden /> Share “{current.name}”
                  </button>
                )}
                <button type="button" onClick={() => setMode("new")} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2">
                  <Plus size={15} aria-hidden /> New graph
                </button>
              </div>
            </>
          )}

          {mode === "new" && (
            <form action={create} className="space-y-3 p-1">
              <Header title="New graph" onBack={() => setMode("list")} />
              <Field label="Name"><Input name="name" required maxLength={80} autoFocus placeholder="For Sara, Work, Holiday plans…" /></Field>
              <Field label="What is it for?">
                <Select name="kind" defaultValue="shared">
                  <option value="shared">To share with someone</option>
                  <option value="personal">Just me</option>
                  <option value="work">Work</option>
                  <option value="other">Something else</option>
                </Select>
              </Field>
              <p className="text-xs text-muted">It starts empty. Nothing from your other graphs is copied in.</p>
              <div className="flex justify-end"><Button size="sm" disabled={busy}>{busy ? "Making it…" : "Make graph"}</Button></div>
            </form>
          )}

          {mode === "share" && <SharePanel graph={current} onBack={() => setMode("list")} />}

          {error && <p role="alert" className="px-2 pt-2 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold">{title}</h2>
      <button type="button" onClick={onBack} aria-label="Back" className="rounded-md p-1 text-muted hover:bg-surface-2"><X size={14} /></button>
    </div>
  );
}

function SharePanel({ graph, onBack }: { graph: SwitcherGraph; onBack: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; link?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    const res = await fetch(`/api/graphs/${graph.id}/members`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? "Couldn't load who is in this graph."); return; }
    setMembers(data.members ?? []);
    setInvites((data.invites ?? []).filter((i: Invite) => i.state === "pending"));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [graph.id]);

  async function invite(form: FormData) {
    setBusy(true); setError(null); setResult(null); setCopied(false);
    const email = String(form.get("email") ?? "").trim();
    try {
      const r = await post(`/api/graphs/${graph.id}/invites`, { email, role: String(form.get("role") ?? "editor") });
      setResult(r.added
        ? { text: `${email} already has an account and can now open “${graph.name}”.` }
        : { text: `Send ${email} this link. It works once, for 14 days.`, link: r.inviteUrl });
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 p-1">
      <Header title={`Share “${graph.name}”`} onBack={onBack} />
      <p className="text-xs text-muted">They see only this graph. Your other graphs stay hidden from them.</p>
      <form action={invite} className="space-y-2">
        <Field label="Their email"><Input name="email" type="email" required autoFocus placeholder="sara@example.com" /></Field>
        <Field label="They can">
          <Select name="role" defaultValue="editor">
            <option value="editor">Add and edit</option>
            <option value="viewer">Only look</option>
          </Select>
        </Field>
        <div className="flex justify-end"><Button size="sm" disabled={busy}>{busy ? "Sharing…" : "Share"}</Button></div>
      </form>
      {result && (
        <div className="rounded-md bg-accent-tint p-2 text-xs">
          <p>{result.text}</p>
          {result.link && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-1.5 py-1">{result.link}</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText(result.link!).then(() => setCopied(true)); }}
                className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-surface"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="border-t border-line pt-2">
        <h3 className="px-1 text-xs font-medium text-muted">Who is in it</h3>
        {members === null ? (
          <p className="px-1 py-1 text-xs text-muted">Loading…</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                <span className="min-w-0 truncate">{m.isYou ? `${m.name} (you)` : m.name}</span>
                <span className="shrink-0 text-xs text-muted">{ROLE_LABEL[m.role] ?? m.role}</span>
              </li>
            ))}
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 px-1 py-1 text-sm text-muted">
                <span className="min-w-0 truncate">{i.email}</span>
                <span className="shrink-0 text-xs">Invited</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
