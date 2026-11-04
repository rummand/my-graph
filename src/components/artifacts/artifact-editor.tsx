"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { ChevronLeft, History, Play, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { Badge, Button, Field, Input, Select, Tabs, Textarea } from "@/components/ui";
import { uncitedClaims, type ArtifactContent, type Citation, type Section } from "@/lib/artifacts/content";
import type { ArtifactView, DiffPart, VersionSummary } from "@/lib/artifacts";
import type { DesignSetView } from "@/lib/design-sets/tokens";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { ArtifactPreview } from "./artifact-preview";
import { ContentEditor } from "./block-editor";
import { ExportMenu } from "./export-menu";
import { ArtifactCompliance, PublishCompliance } from "@/components/compliance/artifact";

type Loaded = { artifact: ArtifactView; set: DesignSetView };
type Proposal = { section: Section; citations: Citation[]; before: string; after: string; diff: DiffPart[] };

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? "Something went wrong." };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: "Something went wrong." };
  }
}

const EASE = [0.22, 1, 0.36, 1] as const;

export function ArtifactEditor({ initial, sets, graphName }: { initial: Loaded; sets: { id: string; name: string }[]; graphName: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [title, setTitle] = useState(initial.artifact.title);
  const [content, setContent] = useState<ArtifactContent>(initial.artifact.content);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [present, setPresent] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [visibility, setVisibility] = useState<"private" | "parents" | "household">(initial.artifact.visibility === "private" ? "household" : initial.artifact.visibility);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [regen, setRegen] = useState<{ section: Section; instruction: string; busy: boolean; proposal: Proposal | null; error: string | null } | null>(null);
  const a = data.artifact;
  const drafting = content.draft?.status === "running";
  const canEdit = a.canEdit;

  const load = useCallback((d: Loaded) => {
    setData(d);
    setTitle(d.artifact.title);
    setContent(d.artifact.content);
    setDirty(false);
  }, []);

  // While the assistant drafts, check back every few seconds.
  useEffect(() => {
    if (!drafting) return;
    const h = setInterval(async () => {
      const r = await api<Loaded>(`/api/artifacts/${a.id}`);
      if (r.ok && r.data.artifact.content.draft?.status !== "running") load(r.data);
    }, 2500);
    return () => clearInterval(h);
  }, [drafting, a.id, load]);

  const save = useCallback(async (extra: Record<string, unknown> = {}): Promise<Loaded | null> => {
    setSaving(true);
    setError(null);
    const r = await api<Loaded>(`/api/artifacts/${a.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title, content, baseVersion: data.artifact.version, ...extra }),
    });
    setSaving(false);
    if (!r.ok) { setError(r.status === 409 ? t("artifacts.editor.conflict") : r.error); return null; }
    load(r.data);
    setSavedAt(Date.now());
    return r.data;
  }, [a.id, title, content, data.artifact.version, load, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && canEdit) { e.preventDefault(); if (dirty) void save(); }
    };
    const onLeave = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onLeave); };
  }, [dirty, save, canEdit]);

  const change = (c: ArtifactContent) => { setContent(c); setDirty(true); };

  async function act(path: string, body?: unknown) {
    if (dirty) { const s = await save(); if (!s) return; }
    setError(null);
    const r = await api<Loaded>(`/api/artifacts/${a.id}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
    if (!r.ok) { setError(r.error); return; }
    load(r.data);
  }

  async function changeSet(id: string) {
    await save({ designSetId: id });
  }

  async function openVersions() {
    setShowVersions(true);
    const r = await api<{ versions: VersionSummary[] }>(`/api/artifacts/${a.id}/versions`);
    setVersions(r.ok ? r.data.versions : []);
  }

  async function restore(n: number) {
    const r = await api<Loaded>(`/api/artifacts/${a.id}/versions/${n}`, { method: "POST", body: "{}" });
    if (!r.ok) { setError(r.error); return; }
    load(r.data);
    setShowVersions(false);
  }

  async function askRegen() {
    if (!regen) return;
    if (dirty) { const s = await save(); if (!s) return; }
    setRegen({ ...regen, busy: true, error: null, proposal: null });
    const r = await api<{ proposal: Proposal }>(`/api/artifacts/${a.id}/sections/${encodeURIComponent(regen.section.id)}/regenerate`, {
      method: "POST", body: JSON.stringify({ instruction: regen.instruction || undefined }),
    });
    setRegen((x) => x && ({ ...x, busy: false, proposal: r.ok ? r.data.proposal : null, error: r.ok ? null : r.error }));
  }

  async function acceptRegen() {
    if (!regen?.proposal) return;
    const r = await api<Loaded>(`/api/artifacts/${a.id}/sections/${encodeURIComponent(regen.section.id)}`, {
      method: "PUT", body: JSON.stringify({ section: regen.proposal.section, citations: regen.proposal.citations, baseVersion: data.artifact.version }),
    });
    if (!r.ok) { setRegen({ ...regen, error: r.error }); return; }
    load(r.data);
    setRegen(null);
  }

  async function remove() {
    if (!window.confirm(t("artifacts.editor.deleteConfirm"))) return;
    const r = await api(`/api/artifacts/${a.id}`, { method: "DELETE" });
    if (r.ok) router.push("/artifacts"); else setError(r.error);
  }

  const uncited = uncitedClaims(content).length;
  const byline = t("artifacts.render.byline", { name: a.ownerName ?? "", graph: graphName, date: fmt(a.publishedAt ?? a.updatedAt) });
  const preview = (
    <ArtifactPreview kind={a.kind} title={title} content={content} tokens={data.set.tokens} template={data.set.templates[a.kind]}
      status={a.status} byline={byline} scope={`e${a.id.slice(0, 8)}`} present={present} onExitPresent={() => setPresent(false)}
      className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--line)]" />
  );
  const needsRefresh = a.status === "published" && a.designSetLatest > a.designSetVersion;

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/artifacts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" aria-hidden />{t("artifacts.editor.back")}</Link>
        <Badge tone={a.status === "published" ? "accent" : "neutral"}>{t(`artifacts.status.${a.status}`)}</Badge>
        <span className="text-sm text-muted">{t(`artifacts.kinds.${a.kind}`)}</span>
        <span className="ml-auto text-sm text-muted" aria-live="polite">
          {saving ? t("artifacts.editor.saving") : dirty ? t("artifacts.editor.unsaved") : savedAt ? t("artifacts.editor.saved") : ""}
        </span>
      </div>

      <div className="mb-5 flex flex-wrap items-start gap-3">
        {canEdit ? (
          <input aria-label={t("artifacts.editor.titleLabel")} value={title} maxLength={200} onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
            className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 -mx-1 text-[28px]/[1.15] font-semibold tracking-[-0.02em] text-fg transition-colors hover:bg-surface-2/60 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent" />
        ) : (
          <h1 className="min-w-0 flex-1 text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{a.title}</h1>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {a.kind === "deck" && <Button variant="secondary" onClick={() => setPresent(true)}><Play className="size-4" aria-hidden />{t("artifacts.editor.present")}</Button>}
          <ExportMenu id={a.id} kind={a.kind} />
          {canEdit && <Button variant="ghost" onClick={openVersions} title={t("artifacts.editor.versions")}><History className="size-4" aria-hidden /><span className="hidden sm:inline">{t("artifacts.editor.versions")}</span></Button>}
          {canEdit && <Button variant="secondary" disabled={!dirty || saving} onClick={() => void save()}>{t("artifacts.editor.save")}</Button>}
          {canEdit && (a.status === "draft"
            ? <Button disabled={drafting || !content.sections.length} onClick={() => setPublishing(true)}>{t("artifacts.editor.publish")}</Button>
            : <Button variant="secondary" onClick={() => void act("unpublish")}>{t("artifacts.editor.unpublish")}</Button>)}
        </div>
      </div>

      {error && <p role="alert" className="mb-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      {!canEdit && <p className="mb-4 text-sm text-muted">{t("artifacts.editor.readOnly", { name: a.ownerName ?? "" })}</p>}
      {needsRefresh && canEdit && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-surface px-3 py-2 text-sm">
          <span className="text-muted">{t("artifacts.editor.refreshHint", { set: a.designSetName })}</span>
          <Button size="sm" variant="secondary" onClick={() => void act("refresh-design")}><RefreshCw className="size-3.5" aria-hidden />{t("artifacts.editor.refreshDesign")}</Button>
        </div>
      )}
      {content.draft?.message && !drafting && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">
          <span>{content.draft.message}</span>
          {canEdit && a.status === "draft" && <Button size="sm" variant="secondary" onClick={() => void act("redraft")}>{t("artifacts.draft.again")}</Button>}
        </div>
      )}

      {!canEdit ? preview : (
        <>
          <Tabs className="mb-4 lg:hidden" value={tab} onSelect={setTab} items={[{ value: "edit", label: t("artifacts.editor.edit") }, { value: "preview", label: t("artifacts.editor.preview") }]} />
          <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <div className={clsx("min-w-0", tab !== "edit" && "hidden lg:block")}>
              {drafting ? (
                <div className="rounded-lg bg-surface p-5">
                  <p className="flex items-center gap-2 font-medium"><Sparkles className="size-4 animate-pulse text-accent" aria-hidden />{t("artifacts.drafting")}</p>
                  <p className="mt-1 text-sm text-muted">{t("artifacts.draft.running")}</p>
                </div>
              ) : (
                <div className="grid gap-6">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("artifacts.editor.design")}>
                      <Select value={a.designSetId} onChange={(e) => void changeSet(e.target.value)}>
                        {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    </Field>
                    <Field label={t("artifacts.editor.subtitle")}>
                      <Input value={content.subtitle} placeholder={t("artifacts.editor.subtitlePlaceholder")} onChange={(e) => change({ ...content, subtitle: e.target.value })} />
                    </Field>
                  </div>
                  {uncited > 0 && (
                    <p className="rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">
                      {t("artifacts.editor.uncited", { count: uncited })}. {t("artifacts.editor.uncitedHint")}
                    </p>
                  )}
                  <ArtifactCompliance artifactId={a.id} title={title} content={content} canEdit={canEdit} onFix={change} />
                  <ContentEditor content={content} onChange={change}
                    onRegenerate={(s) => setRegen({ section: s, instruction: "", busy: false, proposal: null, error: null })} />
                  <div className="border-t border-line pt-4">
                    <Button variant="ghost" onClick={remove} className="text-danger"><Trash2 className="size-4" aria-hidden />{t("artifacts.editor.delete")}</Button>
                  </div>
                </div>
              )}
            </div>
            <div className={clsx("min-w-0", tab !== "preview" && "hidden lg:block")}>
              <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-auto">{preview}</div>
            </div>
          </div>
        </>
      )}

      <AnimatePresence>
        {publishing && (
          <Dialog key="pub" title={t("artifacts.editor.publishTitle")} onClose={() => setPublishing(false)}>
            <p className="text-sm text-muted">{t("artifacts.editor.publishLead")}</p>
            {uncited > 0 && <p className="mt-3 text-sm text-warn">{t("artifacts.editor.uncited", { count: uncited })}</p>}
            <fieldset className="mt-4 grid gap-1">
              <legend className="mb-1.5 text-sm font-medium">{t("artifacts.visibility.label")}</legend>
              {(["household", "parents", "private"] as const).map((vv) => (
                <label key={vv} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
                  <input type="radio" name="vis" checked={visibility === vv} onChange={() => setVisibility(vv)} className="accent-[var(--fg)]" />
                  {t(`artifacts.visibility.${vv}`, { graph: graphName })}
                </label>
              ))}
            </fieldset>
            <PublishCompliance artifactId={a.id} title={title} content={content} confirmLabel={t("artifacts.editor.publishConfirm")} cancelLabel={t("common.cancel", undefined, "Cancel")}
              onCancel={() => setPublishing(false)}
              onPublish={async (withContent) => {
                if (withContent) { const s = await save({ content: withContent }); if (!s) return; }
                setPublishing(false);
                await act("publish", { visibility });
              }} />
          </Dialog>
        )}
        {regen && (
          <Dialog key="regen" wide title={t("artifacts.regen.title", { section: regen.section.title || t("artifacts.editor.sectionTitle") })} onClose={() => setRegen(null)}>
            {!regen.proposal ? (
              <>
                <Field label={t("artifacts.editor.regenInstruction")}>
                  <Textarea rows={2} value={regen.instruction} placeholder={t("artifacts.editor.regenPlaceholder")} onChange={(e) => setRegen({ ...regen, instruction: e.target.value })} />
                </Field>
                {regen.busy && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Sparkles className="size-4 animate-pulse text-accent" aria-hidden />{t("artifacts.regen.working")}</p>}
                {regen.error && <p role="alert" className="mt-3 text-sm text-danger">{regen.error}</p>}
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setRegen(null)}>{t("common.cancel", undefined, "Cancel")}</Button>
                  <Button disabled={regen.busy} onClick={() => void askRegen()}><Sparkles className="size-4" aria-hidden />{t("artifacts.editor.regenGo")}</Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">{t("artifacts.regen.lead")}</p>
                <div className="mt-3 max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-md bg-surface-2/60 p-3 text-[15px] leading-relaxed">
                  {regen.proposal.diff.map((p, i) => p.op === "same" ? <span key={i}>{p.text}</span>
                    : p.op === "del" ? <del key={i} title={t("artifacts.regen.removed")} className="rounded-sm bg-danger-tint text-danger">{p.text}</del>
                    : <ins key={i} title={t("artifacts.regen.added")} className="rounded-sm bg-accent-tint text-accent no-underline">{p.text}</ins>)}
                </div>
                {regen.error && <p role="alert" className="mt-3 text-sm text-danger">{regen.error}</p>}
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setRegen(null)}>{t("artifacts.regen.keep")}</Button>
                  <Button onClick={() => void acceptRegen()}>{t("artifacts.regen.accept")}</Button>
                </div>
              </>
            )}
          </Dialog>
        )}
        {showVersions && (
          <motion.aside key="ver" role="dialog" aria-label={t("artifacts.editor.versions")}
            className="fixed inset-y-0 right-0 z-50 w-[min(380px,100vw)] overflow-auto bg-surface p-4 shadow-float"
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.22, ease: EASE }}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{t("artifacts.editor.versions")}</h2>
              <button type="button" aria-label={t("shell.nav.close", undefined, "Close")} onClick={() => setShowVersions(false)} className="rounded-md p-2 text-muted hover:bg-surface-2"><X className="size-5" /></button>
            </div>
            {versions === null ? <p className="text-sm text-muted">…</p> : versions.length === 0 ? <p className="text-sm text-muted">{t("artifacts.editor.versionsEmpty")}</p> : (
              <ol className="grid gap-1">
                {versions.map((ver) => (
                  <li key={ver.version} className="flex items-start justify-between gap-3 rounded-md px-2 py-2 hover:bg-surface-2/60">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium tabular-nums">{t("artifacts.sets.version", { n: ver.version })} · {t(`artifacts.versionEvents.${ver.event}`, undefined, ver.event.replace(/_/g, " "))}</span>
                      <span className="block text-xs text-muted">{fmt(ver.createdAt, "dateTime")}{ver.by ? `, ${ver.by}` : ver.authorKind === "assistant" ? `, ${t("artifacts.versionEvents.assistant", undefined, "assistant")}` : ""}</span>
                    </span>
                    {ver.version !== a.version && <Button size="sm" variant="ghost" onClick={() => void restore(ver.version)}>{t("artifacts.editor.restore")}</Button>}
                  </li>
                ))}
              </ol>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function Dialog({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <motion.div className="fixed inset-0 z-50 bg-fg/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <div className="pointer-events-none fixed inset-x-0 top-[12vh] z-50 flex justify-center px-4">
        <motion.div role="dialog" aria-modal="true" aria-label={title}
          className={clsx("pointer-events-auto max-h-[84vh] w-full overflow-y-auto rounded-lg bg-surface p-5 shadow-float", wide ? "max-w-2xl" : "max-w-md")}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.18, ease: EASE }}>
          <h2 className="mb-2 text-lg font-semibold">{title}</h2>
          {children}
        </motion.div>
      </div>
    </>
  );
}
