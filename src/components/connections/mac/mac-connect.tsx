"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, Copy, Download } from "lucide-react";
import { Badge, Button, buttonClass, Field, Input, Section, Select } from "@/components/ui";
import { formatAgo, useFormatDate, useLocale, useT } from "@/lib/i18n/client";
import type { MacStatus } from "@/lib/connectors/mac/server";
import { api, StatusDot, useNow } from "../bits";

type Pairing = { code: string; expiresAt: string };
type Visibility = "private" | "parents" | "household";
type Scope = "chosen" | "known";
type Since = "3m" | "1y" | "all";

type Draft = {
  visibility: Visibility;
  messagesOn: boolean; scope: Scope; chats: string[]; since: Since;
  notesOn: boolean; folders: string[] | null;
};

const draftOf = (s: MacStatus): Draft => ({
  visibility: s.choices.visibility,
  messagesOn: s.choices.messages.enabled, scope: s.choices.messages.scope, chats: s.choices.messages.chats, since: s.choices.messages.since,
  notesOn: s.choices.notes.enabled, folders: s.choices.notes.folders,
});

const same = (a: Draft, b: Draft) => JSON.stringify({ ...a, chats: [...a.chats].sort() }) === JSON.stringify({ ...b, chats: [...b.chats].sort() });

/** The My Graph for Mac page: status, pairing, setup steps, what it may send, the optional schedule. */
export function MacConnect({ initial }: { initial: MacStatus }) {
  const t = useT();
  const fmt = useFormatDate();
  const locale = useLocale();
  const tick = useNow();
  const [status, setStatus] = useState(initial);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const ago = (iso: string | null | undefined) => (iso ? formatAgo(iso, locale, new Date(Math.max(now, tick))) : "");
  const saved = draftOf(status);
  const dirty = !same(draft, saved);

  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  const reload = useCallback(async () => {
    const s = await api<MacStatus>("/api/connections/mac").catch(() => null);
    if (!s) return;
    if (pairing && !s.pairing && s.helper) {
      setPairing(null);
      setNotice(t("mac.status.justPaired"));
    }
    // Keep what the person is editing; take the new choices only when nothing is being edited.
    const prev = draftOf(statusRef.current);
    setDraft((d) => (same(d, prev) ? draftOf(s) : d));
    setStatus(s);
  }, [pairing, t]);

  const live = !!pairing && Date.parse(pairing.expiresAt) > now;
  // While a code is waiting, or the helper is paired but hasn't listed anything yet, look again every few seconds.
  const waitingForMac = live || (!!status.helper && !status.catalog.at);
  useEffect(() => {
    if (!waitingForMac) return;
    const id = setInterval(() => { setNow(Date.now()); void reload(); }, live ? 3000 : 8000);
    return () => clearInterval(id);
  }, [waitingForMac, live, reload]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : t("mac.errors.generic")); } finally { setBusy(false); }
  };

  const start = () => act(async () => {
    const p = await api<Pairing>("/api/connections/mac", { method: "POST", json: { visibility: draft.visibility } });
    setPairing(p);
    setNow(Date.now());
    await reload();
  });

  const patch = (json: Record<string, unknown>, message: string) => act(async () => {
    const s = await api<MacStatus>("/api/connections/mac", { method: "PATCH", json });
    setStatus(s);
    setDraft(draftOf(s));
    setNotice(message);
  });

  const save = () => patch({
    visibility: draft.visibility,
    messages: { enabled: draft.messagesOn, scope: draft.scope, chats: draft.chats, since: draft.since },
    notes: { enabled: draft.notesOn, folders: draft.folders },
  }, t("mac.choose.saved"));

  const signOut = () => {
    if (!window.confirm(t("mac.status.signOutConfirm"))) return;
    void patch({ signOutHelper: true }, t("mac.status.signedOut"));
  };

  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { /* select it by hand */ }
  };

  const c = status.connection;
  const command = pairing && live ? `node ~/Downloads/my-graph-mac.mjs --code ${pairing.code}` : "node ~/Downloads/my-graph-mac.mjs";
  const what = status.lastSend
    ? [
      status.lastSend.messages !== undefined ? t("mac.status.messages", { count: status.lastSend.messages }) : null,
      status.lastSend.notes !== undefined ? t("mac.status.notes", { count: status.lastSend.notes }) : null,
    ].filter(Boolean).join(", ")
    : "";

  return (
    <div className="space-y-10">
      {error && <p role="alert" className="rounded-md bg-surface px-3 py-2 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-md bg-accent-tint px-3 py-2 text-sm">{notice}</p>}

      {c && (
        <Section title={t("mac.status.title")}>
          <div className="rounded-lg bg-surface px-4 py-4">
            <p className="flex items-center gap-2">
              <StatusDot status={status.helper ? c.status : "needs_you"} />
              <span className={clsx("text-sm", !status.helper ? "text-warn" : "text-muted")}>
                {!status.helper ? t("mac.status.waiting")
                  : c.status === "paused" ? t("mac.status.paused")
                  : status.helper.device ? t("mac.status.paired", { device: status.helper.device }) : t("mac.status.pairedNoName")}
              </span>
            </p>
            {status.helper?.lastSeenAt && <p className="mt-1 text-sm text-muted">{t("mac.status.lastSeen", { ago: ago(status.helper.lastSeenAt) })}</p>}
            {status.helper && (
              <p className="mt-1 text-sm">
                {status.lastSend ? t("mac.status.lastSend", { ago: ago(status.lastSend.at), what: what || "0" }) : t("mac.status.nothingYet")}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`/connections/${c.id}`} className={buttonClass("secondary", "sm")}>{t("mac.status.open")}</Link>
              {status.helper && <Button size="sm" variant="ghost" disabled={busy} onClick={signOut}>{t("mac.status.signOut")}</Button>}
            </div>
          </div>
        </Section>
      )}

      <Section title={t("mac.steps.title")}>
        <p className="mb-6 max-w-[65ch] text-sm text-muted">{t("mac.steps.lead")}</p>
        <ol className="space-y-8">
          <Step n={1} title={t("mac.steps.one.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("mac.steps.one.body")}</p>
            {pairing && live ? (
              <div className="mt-3">
                <p className="text-sm text-muted">{t("mac.steps.one.code")}</p>
                <p className="mt-1 flex flex-wrap items-center gap-3">
                  <span className="select-all text-[28px]/[1.15] font-semibold tabular-nums tracking-[0.08em]" aria-live="polite">{pairing.code}</span>
                  <Button size="sm" variant="ghost" onClick={() => copy("code", pairing.code)}>
                    {copied === "code" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                    {copied === "code" ? t("mac.steps.one.copied") : t("mac.steps.one.copy")}
                  </Button>
                </p>
                <p className="mt-1 text-sm text-muted">{t("mac.steps.one.expires", { time: fmt(pairing.expiresAt, "time") })}</p>
                <Button size="sm" variant="secondary" className="mt-3" disabled={busy} onClick={start}>{t("mac.steps.one.again")}</Button>
              </div>
            ) : (
              <>
                {pairing && <p className="mt-3 text-sm text-warn">{t("mac.steps.one.expired")}</p>}
                <Button className="mt-3" disabled={busy} onClick={start}>{pairing ? t("mac.steps.one.again") : t("mac.steps.one.action")}</Button>
              </>
            )}
          </Step>

          <Step n={2} title={t("mac.steps.two.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("mac.steps.two.body")}</p>
            <a href="/api/connections/mac/helper" download className={clsx(buttonClass("secondary", "sm"), "mt-3")}>
              <Download className="size-4" aria-hidden />{t("mac.steps.two.download")}
            </a>
          </Step>

          <Step n={3} title={t("mac.steps.three.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("mac.steps.three.body")}</p>
            <p className="mt-2 max-w-[60ch] text-sm text-muted">{t("mac.steps.three.notes")}</p>
            <p className="mt-2 max-w-[60ch] text-sm text-muted">{t("mac.steps.three.skip")}</p>
          </Step>

          <Step n={4} title={t("mac.steps.four.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("mac.steps.four.body")}</p>
            <Command text={command} copied={copied === "cmd"} onCopy={() => copy("cmd", command)} label={t("mac.steps.one.copy")} />
            <p className="mt-2 max-w-[60ch] text-sm text-muted">{t("mac.steps.four.first")}</p>
            {live && <p className="mt-2 flex items-center gap-2 text-sm"><StatusDot status="running" />{t("mac.steps.four.watching")}</p>}
          </Step>
        </ol>
      </Section>

      {c && <Choices status={status} draft={draft} setDraft={setDraft} dirty={dirty} busy={busy} onSave={save} ago={ago}
        onResend={(which) => patch({ resend: which }, t("mac.choose.resend.done"))} />}

      <Section title={t("mac.schedule.title")}>
        <p className="max-w-[65ch] text-sm text-muted">{t("mac.schedule.body")}</p>
        <Command text="node ~/Downloads/my-graph-mac.mjs schedule --every 60" copied={copied === "sched"} onCopy={() => copy("sched", "node ~/Downloads/my-graph-mac.mjs schedule --every 60")} label={t("mac.steps.one.copy")} />
        <p className="mt-3 text-sm text-muted">{t("mac.schedule.stop")}</p>
        <Command text="node ~/Downloads/my-graph-mac.mjs unschedule" copied={copied === "unsched"} onCopy={() => copy("unsched", "node ~/Downloads/my-graph-mac.mjs unschedule")} label={t("mac.steps.one.copy")} />
      </Section>

      <Section title={t("mac.how.title")}>
        <ul className="max-w-[65ch] list-disc space-y-2 pl-5 text-sm text-muted marker:text-line">
          {(["only", "list", "key", "private", "proposals", "cursor"] as const).map((k) => <li key={k}>{t(`mac.how.${k}`)}</li>)}
        </ul>
      </Section>
    </div>
  );
}

function Choices({ status, draft, setDraft, dirty, busy, onSave, onResend, ago }: {
  status: MacStatus; draft: Draft; setDraft: (fn: (d: Draft) => Draft) => void; dirty: boolean; busy: boolean;
  onSave: () => void; onResend: (which: "messages" | "notes") => void; ago: (iso: string | null | undefined) => string;
}) {
  const t = useT();
  const fmt = useFormatDate();
  const [q, setQ] = useState("");
  const chosen = useMemo(() => new Set(draft.chats), [draft.chats]);
  const chats = status.catalog.chats;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return chats;
    return chats.filter((c) => [c.name ?? "", ...c.participants.flatMap((p) => [p.handle, p.name ?? ""])].some((x) => x.toLowerCase().includes(s)));
  }, [chats, q]);
  const toggleChat = (id: string) => setDraft((d) => ({ ...d, chats: chosen.has(id) ? d.chats.filter((x) => x !== id) : [...d.chats, id] }));
  const folders = status.catalog.folders;
  const toggleFolder = (name: string) => setDraft((d) => {
    const cur = new Set(d.folders ?? folders.map((f) => f.name));
    if (cur.has(name)) cur.delete(name); else cur.add(name);
    return { ...d, folders: [...cur] };
  });
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <Section title={t("mac.choose.title")}>
      <p className="mb-4 max-w-[65ch] text-sm text-muted">{t("mac.choose.lead")}</p>
      {!status.catalog.at
        ? <p className="mb-6 max-w-[65ch] text-sm text-muted">{t("mac.choose.noCatalog")}</p>
        : <p className="mb-6 text-sm text-muted">{t("mac.choose.catalogAt", { ago: ago(status.catalog.at) })}</p>}

      <div className="space-y-8">
        <div>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--fg)]" checked={draft.messagesOn} onChange={(e) => set({ messagesOn: e.target.checked })} />
            <span>
              <span className="font-medium">{t("mac.choose.messages.label")}</span>
              <span className="block text-sm text-muted">{t("mac.choose.messages.hint")}</span>
            </span>
          </label>
          {status.catalog.canRead?.messages === false && <p className="mt-2 pl-7 text-sm text-warn">{t("mac.choose.messages.cantRead")}</p>}
          {draft.messagesOn && (
            <div className="mt-4 space-y-4 pl-7">
              <fieldset>
                <legend className="text-sm font-medium">{t("mac.choose.messages.scope")}</legend>
                {(["chosen", "known"] as const).map((s) => (
                  <label key={s} className="mt-2 flex items-center gap-2 text-sm">
                    <input type="radio" name="mac-scope" className="size-4 accent-[var(--fg)]" checked={draft.scope === s} onChange={() => set({ scope: s })} />
                    {t(`mac.choose.messages.${s}`)}
                  </label>
                ))}
                {draft.scope === "known" && <p className="mt-2 text-sm text-muted">{t("mac.choose.messages.knownCount", { count: status.knownCount })}</p>}
              </fieldset>
              <Field label={t("mac.choose.messages.since")} className="max-w-xs">
                <Select value={draft.since} onChange={(e) => set({ since: e.target.value as Since })}>
                  <option value="3m">{t("mac.choose.messages.since3m")}</option>
                  <option value="1y">{t("mac.choose.messages.since1y")}</option>
                  <option value="all">{t("mac.choose.messages.sinceAll")}</option>
                </Select>
              </Field>
              {draft.scope === "chosen" && chats.length > 0 && (
                <div>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <Field label={t("mac.choose.messages.filter")} className="w-full max-w-xs">
                      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
                    </Field>
                    <p className="text-sm text-muted" aria-live="polite">{t("mac.choose.messages.selected", { count: draft.chats.length })}</p>
                  </div>
                  <ul className="mt-3 max-h-96 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                    {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">{t("mac.choose.messages.none")}</li>}
                    {shown.map((c) => {
                      const who = c.participants.map((p) => p.name ?? p.handle).join(", ");
                      return (
                        <li key={c.id}>
                          <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-surface">
                            <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--fg)]" checked={chosen.has(c.id)} onChange={() => toggleChat(c.id)} />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="truncate font-medium">{c.name || who || c.id}</span>
                                {c.participants.length > 1 && <Badge>{t("mac.choose.messages.group")}</Badge>}
                                {c.known && <Badge tone="accent">{t("mac.choose.messages.inGraph")}</Badge>}
                              </span>
                              <span className="block truncate text-sm text-muted">
                                {c.name && who ? `${who} · ` : ""}{t("mac.choose.messages.count", { count: c.count })}{c.lastAt ? ` · ${fmt(c.lastAt, "date")}` : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--fg)]" checked={draft.notesOn} onChange={(e) => set({ notesOn: e.target.checked })} />
            <span>
              <span className="font-medium">{t("mac.choose.notes.label")}</span>
              <span className="block text-sm text-muted">{t("mac.choose.notes.hint")}</span>
            </span>
          </label>
          {status.catalog.canRead?.notes === false && <p className="mt-2 pl-7 text-sm text-warn">{t("mac.choose.notes.cantRead")}</p>}
          {draft.notesOn && (
            <div className="mt-4 pl-7">
              {folders.length === 0 ? <p className="text-sm text-muted">{t("mac.choose.notes.noFolders")}</p> : (
                <fieldset>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="mac-folders" className="size-4 accent-[var(--fg)]" checked={draft.folders === null} onChange={() => set({ folders: null })} />
                    {t("mac.choose.notes.all")}
                  </label>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input type="radio" name="mac-folders" className="size-4 accent-[var(--fg)]" checked={draft.folders !== null} onChange={() => set({ folders: draft.folders ?? [] })} />
                    {t("mac.choose.notes.folders")}
                  </label>
                  {draft.folders !== null && (
                    <ul className="mt-3 space-y-1.5 pl-6">
                      {folders.map((f) => (
                        <li key={f.name}>
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" className="size-4 accent-[var(--fg)]" checked={draft.folders?.includes(f.name) ?? false} onChange={() => toggleFolder(f.name)} />
                            <span>{f.name}</span>
                            <span className="text-muted">· {t("mac.choose.notes.count", { count: f.count })}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </fieldset>
              )}
            </div>
          )}
        </div>

        <Field label={t("mac.choose.visibility.label")} hint={t("mac.choose.visibility.hint")} className="max-w-xs">
          <Select value={draft.visibility} onChange={(e) => set({ visibility: e.target.value as Visibility })}>
            <option value="private">{t("connections.visibility.private")}</option>
            <option value="parents">{t("connections.visibility.parents")}</option>
            <option value="household">{t("connections.visibility.household")}</option>
          </Select>
        </Field>

        <Button disabled={busy || !dirty} onClick={onSave}>{t("mac.choose.save")}</Button>

        {(status.sent.messagesUpTo !== null || status.sent.notesUpTo !== null) && (
          <div className="border-t border-line pt-6">
            <h3 className="font-medium">{t("mac.choose.resend.title")}</h3>
            <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("mac.choose.resend.body")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {status.sent.messagesUpTo !== null && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onResend("messages")}>{t("mac.choose.resend.messages")}</Button>}
              {status.sent.notesUpTo !== null && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onResend("notes")}>{t("mac.choose.resend.notes")}</Button>}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function Command({ text, copied, onCopy, label }: { text: string; copied: boolean; onCopy: () => void; label: string }) {
  return (
    <div className="mt-3 flex max-w-xl items-center gap-2 rounded-md bg-surface-2 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm">{text}</code>
      <Button size="sm" variant="ghost" onClick={onCopy} aria-label={label}>
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </Button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span aria-hidden className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums text-muted">{n}</span>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{title}</h3>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}
