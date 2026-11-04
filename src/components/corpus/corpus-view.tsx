"use client";
/**
 * A corpus: its details, the documents its rules are read from, "Read rules" (and "New version…"), the rules waiting
 * for a decision (Approve / Edit / Drop), and the rules in use grouped by section with their quotes, a search and the
 * coverage line ("12 rules, 3 waiting for you, last read 4 Nov").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft, BookOpenText, FileText, Globe, LoaderCircle, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { compareSections, defaultSeverity, SOURCE_ROLES, type Binding, type Modality } from "@/lib/corpus/pure";
import type { CorpusDetail, RuleView } from "@/lib/corpus";
import { CorpusForm, corpusBodyOf, type CorpusFormValue } from "./corpus-form";
import { RuleCard, RuleForm, type RuleEdit } from "./rule-card";

type Res = { ok: true; corpus: CorpusDetail } | { ok: false; error: string };

async function send(url: string, method: string, body?: unknown): Promise<Res & Record<string, unknown>> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? "" };
    return { ok: true, ...data };
  } catch {
    return { ok: false, error: "" };
  }
}

const day = (s: string | null) => (s ? s.slice(0, 10) : "");

export function CorpusView({ initial }: { initial: CorpusDetail }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<null | "library" | "url" | "upload">(null);
  const [versioning, setVersioning] = useState(false);
  const [writing, setWriting] = useState(false);
  const base = `/api/corpora/${c.id}`;
  const running = c.readState?.status === "running";
  const fail = (e: string) => setError(e || t("compliance.errors.failed"));

  const reload = useCallback(async () => {
    const r = await send(base, "GET");
    if (r.ok) setC(r.corpus);
  }, [base]);

  // While the rules are being read, follow along.
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => void reload(), 2500);
    return () => clearInterval(h);
  }, [running, reload]);

  // Documents the library is still reading: check back.
  const processing = c.sources_.some((s) => s.status === "pending" || s.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const h = setInterval(() => void reload(), 4000);
    return () => clearInterval(h);
  }, [processing, reload]);

  async function act(url: string, method: string, body?: unknown) {
    setBusy(true); setError(null);
    const r = await send(url, method, body);
    setBusy(false);
    if (!r.ok) { fail(r.error); return false; }
    if (r.corpus) setC(r.corpus as CorpusDetail);
    return true;
  }

  const startRead = async (mode: "read" | "version", version?: string) => {
    setBusy(true); setError(null);
    const r = await send(`${base}/read`, "POST", { mode, version: version ?? null });
    setBusy(false);
    if (!r.ok) { fail(r.error); return; }
    setVersioning(false);
    await reload();
  };

  const proposed = c.rules.filter((r) => r.status === "proposed");
  const inUse = c.rules.filter((r) => r.status === "active");
  const retired = c.rules.filter((r) => r.status === "retired");
  const byId = useMemo(() => new Map(c.rules.map((r) => [r.id, r])), [c.rules]);
  const match = (r: RuleView) => !q.trim() || `${r.ref} ${r.title} ${r.text} ${r.quote ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
  const groups = useMemo(() => {
    const m = new Map<string, RuleView[]>();
    for (const r of inUse.filter(match)) m.set(r.section, [...(m.get(r.section) ?? []), r]);
    return [...m.entries()].sort((a, b) => compareSections(a[0], b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inUse, q]);

  const edit = (r: RuleView) => async (v: RuleEdit) => {
    const ok = await act(`${base}/rules/${r.id}`, "PATCH", { ref: v.ref, title: v.title, text: v.text, modality: v.modality, severity: v.severity, checkHint: v.checkHint || null });
    return ok ? null : error ?? t("compliance.errors.failed");
  };

  const lastRead = c.readState?.finishedAt ?? null;
  const coverage = [
    t("corpus.coverage.rules", { count: inUse.length }),
    ...(proposed.length ? [t("corpus.coverage.proposed", { count: proposed.length })] : []),
    lastRead ? t("corpus.coverage.lastRead", { date: fmt(lastRead, "date") }) : t("corpus.coverage.neverRead"),
  ].join(", ");

  const formValue: CorpusFormValue = {
    name: c.name, description: c.description ?? "", kind: c.kind, authority: c.authority ?? "", binding: c.binding, version: c.version ?? "",
    effectiveFrom: day(c.effectiveFrom), effectiveTo: day(c.effectiveTo), status: c.status, checkByDefault: c.checkByDefault, scope: c.scope,
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/corpora" className="-ml-2 mb-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />{t("corpus.back")}
      </Link>

      {editing ? (
        <div className="mb-8 rounded-lg bg-surface p-5">
          <CorpusForm initial={formValue} showStatus submitLabel={t("corpus.form.save")} onCancel={() => setEditing(false)}
            onSubmit={async (v) => { const ok = await act(base, "PATCH", corpusBodyOf(v)); if (ok) setEditing(false); return ok ? null : t("compliance.errors.failed"); }} />
        </div>
      ) : (
        <header className="mb-8">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="min-w-0 flex-1 break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{c.name}</h1>
            {c.canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil aria-hidden className="size-3.5" />{t("corpus.form.edit")}</Button>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={c.status === "active" ? "accent" : "neutral"}>{t(`corpus.status.${c.status}`)}</Badge>
            <Badge tone={c.binding === "mandatory" ? "neutral" : "neutral"}>{t(`corpus.binding.${c.binding}`)}</Badge>
            <span>{t(`corpus.kind.${c.kind}`)}{c.authority ? `, ${c.authority}` : ""}{c.version ? `, ${c.version}` : ""}{c.effectiveFrom ? `, ${t("corpus.form.effectiveFrom").toLowerCase()} ${fmt(c.effectiveFrom, "date")}` : ""}</span>
          </div>
          {c.description && <p className="mt-3 max-w-[68ch]">{c.description}</p>}
          <p className={clsx("mt-3 text-sm", proposed.length ? "text-warn" : "text-muted")}>{coverage}</p>
        </header>
      )}

      {error && <p role="alert" className="mb-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}

      {/* Documents */}
      <section aria-labelledby="corpus-sources" className="mb-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="corpus-sources" className="text-lg font-semibold">{t("corpus.sources.title")}</h2>
          <span className="text-sm text-muted">{t("corpus.coverage.sources", { count: c.sources_.length })}</span>
        </div>
        <p className="mt-1 text-sm text-muted">{t("corpus.sources.lead")}</p>
        {c.sources_.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.sources.empty")}</p> : (
          <ul className="mt-3 divide-y divide-line">
            {c.sources_.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                {s.kind === "web" ? <Globe aria-hidden className="size-4 shrink-0 text-muted" /> : <FileText aria-hidden className="size-4 shrink-0 text-muted" />}
                <span className="min-w-0 flex-1">
                  <Link href={`/library/${s.sourceId}`} className="block truncate hover:underline">{s.title}</Link>
                  <span className="block text-xs text-muted">
                    {t(`corpus.role.${s.role}`, undefined, s.role)}
                    {s.status === "pending" || s.status === "processing" ? `, ${t("corpus.sources.processing")}` : s.status === "failed" ? `, ${t("corpus.sources.failed")}` : ""}
                    {s.readAt ? `, ${t("corpus.coverage.lastRead", { date: fmt(s.readAt, "date") })}` : ""}
                  </span>
                </span>
                {(s.status === "pending" || s.status === "processing") && <LoaderCircle aria-hidden className="size-4 animate-spin text-muted" />}
                {c.canManage && (
                  <button type="button" aria-label={`${t("corpus.sources.remove")}: ${s.title}`} title={t("corpus.sources.remove")} disabled={busy}
                    onClick={() => void act(`${base}/sources?sourceId=${s.sourceId}`, "DELETE")}
                    className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"><X aria-hidden className="size-4" /></button>
                )}
              </li>
            ))}
          </ul>
        )}
        {c.canManage && (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant={adding === "library" ? "primary" : "secondary"} onClick={() => setAdding(adding === "library" ? null : "library")}><BookOpenText aria-hidden className="size-4" />{t("corpus.sources.fromLibrary")}</Button>
              <Button size="sm" variant={adding === "upload" ? "primary" : "secondary"} onClick={() => setAdding(adding === "upload" ? null : "upload")}><Upload aria-hidden className="size-4" />{t("corpus.sources.upload")}</Button>
              <Button size="sm" variant={adding === "url" ? "primary" : "secondary"} onClick={() => setAdding(adding === "url" ? null : "url")}><Globe aria-hidden className="size-4" />{t("corpus.sources.url")}</Button>
            </div>
            {adding === "library" && <LibraryPicker have={new Set(c.sources_.map((s) => s.sourceId))} onAdd={(ids, role) => act(`${base}/sources`, "POST", { sourceIds: ids, role })} />}
            {adding === "upload" && <UploadSource onUploaded={(ids, role) => act(`${base}/sources`, "POST", { sourceIds: ids, role })} />}
            {adding === "url" && <UrlSource onAdd={async (url, role) => { const ok = await act(`${base}/sources`, "POST", { url, role }); if (ok) setAdding(null); return ok; }} />}
          </>
        )}
      </section>

      {/* Reading the rules */}
      {c.canManage && (
        <section aria-label={t("corpus.read.button")} className="mb-10 rounded-lg bg-surface p-4">
          {running ? (
            <p className="flex items-center gap-2 text-sm" role="status">
              <LoaderCircle aria-hidden className="size-4 animate-spin text-accent" />
              {c.readState && c.readState.total > 0 ? t("corpus.read.running", { done: c.readState.done, total: c.readState.total }) : t("corpus.read.starting")}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy || !c.sources_.length} onClick={() => void startRead("read")} title={!c.sources_.length ? t("corpus.read.needSources") : undefined}>
                {lastRead ? t("corpus.read.again") : t("corpus.read.button")}
              </Button>
              {inUse.length > 0 && <Button variant="ghost" disabled={busy} onClick={() => setVersioning((x) => !x)}>{t("corpus.read.newVersion")}</Button>}
              {c.readState?.status === "done" && <span className="text-sm text-muted">{c.readState.found ? t("corpus.read.done", { count: c.readState.found }) : t("corpus.read.none")}{c.readState.error ? ` ${c.readState.error}` : ""}</span>}
              {c.readState?.status === "failed" && <span className="text-sm text-danger">{t("corpus.read.failed", { error: c.readState.error ?? "" })}</span>}
            </div>
          )}
          {versioning && !running && <NewVersion name={c.name} current={c.version} onGo={(v) => void startRead("version", v)} busy={busy} />}
        </section>
      )}

      {/* Waiting for a decision */}
      {proposed.length > 0 && (
        <section aria-labelledby="corpus-review" className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="corpus-review" className="text-lg font-semibold">{t("corpus.rules.review", { count: proposed.length })}</h2>
            {c.canManage && <Button size="sm" disabled={busy} onClick={() => void act(`${base}/rules`, "POST", { ids: proposed.map((r) => r.id), action: "approve" })}>{t("corpus.rules.approveAll")}</Button>}
          </div>
          <p className="mt-1 text-sm text-muted">{t("corpus.rules.reviewLead")}</p>
          <ul className="mt-3 space-y-2">
            {proposed.map((r) => (
              <li key={r.id}>
                <RuleCard r={r} canManage={c.canManage} busy={busy} replaces={r.change === "changed" && r.supersedesId ? byId.get(r.supersedesId)?.text ?? null : null}
                  onDecide={(action) => void act(`${base}/rules`, "POST", { ids: [r.id], action })} onEdit={edit(r)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* In use */}
      <section aria-labelledby="corpus-rules" className="mb-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="corpus-rules" className="text-lg font-semibold">{t("corpus.rules.title")}</h2>
          {c.canManage && <Button size="sm" variant="ghost" onClick={() => setWriting((x) => !x)}><Plus aria-hidden className="size-4" />{t("corpus.rules.add")}</Button>}
        </div>
        {writing && (
          <div className="mt-3 rounded-lg bg-surface p-4">
            <p className="mb-3 font-medium">{t("corpus.rules.addTitle")}</p>
            <RuleForm withQuote initial={{ ref: "", title: "", text: "", modality: "must", severity: defaultSeverity("must" as Modality, c.binding as Binding), checkHint: "", quote: "" }}
              onCancel={() => setWriting(false)}
              onSave={async (v) => {
                const ok = await act(`${base}/rules`, "PUT", { ref: v.ref, title: v.title || undefined, text: v.text, modality: v.modality, severity: v.severity, checkHint: v.checkHint || null, quote: v.quote || null });
                if (ok) setWriting(false);
                return ok ? null : t("compliance.errors.failed");
              }} />
          </div>
        )}
        {inUse.length > 0 && (
          <div className="relative mt-3">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <label htmlFor="rule-search" className="sr-only">{t("corpus.rules.search")}</label>
            <Input id="rule-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("corpus.rules.search")} className="pl-9" />
          </div>
        )}
        {inUse.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.rules.empty")}</p> : groups.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.rules.noMatch")}</p> : (
          <div className="mt-4 space-y-6">
            {groups.map(([section, rules]) => (
              <section key={section} aria-label={section}>
                <h3 className="mb-2 text-sm font-semibold text-muted">{section}</h3>
                <ul className="space-y-2">
                  {rules.map((r) => (
                    <li key={r.id}><RuleCard r={r} canManage={c.canManage} busy={busy} onEdit={edit(r)} onRetire={(retire) => void act(`${base}/rules/${r.id}`, "PATCH", { status: retire ? "retired" : "active" })} /></li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {retired.length > 0 && (
          <details className="mt-6">
            <summary className="cursor-pointer text-sm text-muted">{t("corpus.rules.retired")} ({retired.length})</summary>
            <ul className="mt-2 space-y-2">
              {retired.map((r) => <li key={r.id}><RuleCard r={r} canManage={c.canManage} busy={busy} onEdit={edit(r)} onRetire={(retire) => void act(`${base}/rules/${r.id}`, "PATCH", { status: retire ? "retired" : "active" })} /></li>)}
            </ul>
          </details>
        )}
      </section>

      {c.canManage && (
        <div className="border-t border-line pt-4">
          <Button variant="ghost" className="text-danger" disabled={busy} onClick={async () => {
            if (!window.confirm(t("corpus.form.deleteConfirm"))) return;
            const r = await send(base, "DELETE");
            if (r.ok) { router.push("/corpora"); router.refresh(); } else fail(r.error);
          }}><Trash2 aria-hidden className="size-4" />{t("corpus.form.delete")}</Button>
        </div>
      )}
    </div>
  );
}

function RolePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <Field label={t("corpus.sources.role")} className="w-full sm:w-56">
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-9">
        {SOURCE_ROLES.map((r) => <option key={r} value={r}>{t(`corpus.role.${r}`)}</option>)}
      </Select>
    </Field>
  );
}

type LibItem = { id: string; title: string; status: string; mime: string | null };

function LibraryPicker({ have, onAdd }: { have: Set<string>; onAdd: (ids: string[], role: string) => Promise<boolean> }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [role, setRole] = useState("text");
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const h = setTimeout(async () => {
      try {
        const res = await fetch(`/api/library?limit=20${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
        const data = await res.json().catch(() => ({}));
        if (n === seq.current) setItems((data.items ?? []) as LibItem[]);
      } catch { if (n === seq.current) setItems([]); }
    }, 200);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="mt-3 rounded-lg bg-surface p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("corpus.sources.pickSearch")} className="min-w-0 flex-1"><Input type="search" value={q} autoFocus onChange={(e) => setQ(e.target.value)} /></Field>
        <RolePicker value={role} onChange={setRole} />
      </div>
      {items === null ? <p className="mt-3 text-sm text-muted"><LoaderCircle aria-hidden className="inline size-4 animate-spin" /></p> : items.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.sources.pickEmpty")}</p> : (
        <ul className="mt-3 max-h-72 divide-y divide-line overflow-auto">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 py-2">
              <FileText aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm">{it.title}</span>
              {have.has(it.id) ? <span className="text-xs text-muted">{t("corpus.sources.added")}</span> : (
                <Button size="sm" variant="secondary" disabled={busy === it.id} onClick={async () => { setBusy(it.id); await onAdd([it.id], role); setBusy(null); }}>{t("corpus.sources.add")}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UploadSource({ onUploaded }: { onUploaded: (ids: string[], role: string) => Promise<boolean> }) {
  const t = useT();
  const [role, setRole] = useState("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-surface p-4">
      <Field label={t("corpus.sources.upload")} className="min-w-0 flex-1">
        <input type="file" disabled={busy} accept=".pdf,.txt,.md,.docx,.html,.htm,.rtf,.odt" className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true); setError(null);
            const form = new FormData();
            form.append("file", file);
            form.append("visibility", "household");
            try {
              const res = await fetch("/api/library", { method: "POST", body: form });
              const data = await res.json().catch(() => ({}));
              const ids = ((data.results ?? []) as { sourceId?: string }[]).map((r) => r.sourceId).filter((x): x is string => !!x);
              if (!res.ok || !ids.length) setError(data.error ?? t("compliance.errors.failed"));
              else await onUploaded(ids, role);
            } catch { setError(t("compliance.errors.offline")); }
            setBusy(false);
            e.target.value = "";
          }} />
      </Field>
      <RolePicker value={role} onChange={setRole} />
      {busy && <p className="w-full text-sm text-muted"><LoaderCircle aria-hidden className="mr-1.5 inline size-4 animate-spin" />{t("corpus.sources.uploading")}</p>}
      {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
    </div>
  );
}

function UrlSource({ onAdd }: { onAdd: (url: string, role: string) => Promise<boolean> }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [role, setRole] = useState("interpretation");
  const [busy, setBusy] = useState(false);
  return (
    <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-surface p-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onAdd(url.trim(), role); setBusy(false); }}>
      <Field label={t("corpus.sources.url")} className="min-w-0 flex-1"><Input type="url" required value={url} placeholder={t("corpus.sources.urlPlaceholder")} onChange={(e) => setUrl(e.target.value)} /></Field>
      <RolePicker value={role} onChange={setRole} />
      <Button type="submit" disabled={busy || url.trim().length < 4}>{busy ? t("corpus.sources.urlReading") : t("corpus.sources.urlAdd")}</Button>
    </form>
  );
}

function NewVersion({ name, current, onGo, busy }: { name: string; current: string | null; onGo: (version: string) => void; busy: boolean }) {
  const t = useT();
  const [v, setV] = useState("");
  return (
    <form className="mt-4 grid gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); onGo(v.trim()); }}>
      <p className="font-medium">{t("corpus.read.versionTitle", { name })}</p>
      <p className="text-sm text-muted">{t("corpus.read.versionLead")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("corpus.read.versionLabel")} className="w-full sm:w-56"><Input value={v} placeholder={current ?? ""} maxLength={80} onChange={(e) => setV(e.target.value)} /></Field>
        <Button type="submit" disabled={busy}>{t("corpus.read.versionGo")}</Button>
      </div>
    </form>
  );
}
