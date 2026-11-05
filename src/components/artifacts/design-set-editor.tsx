"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Globe, Sparkles, Wand2 } from "lucide-react";
import { Button, Field, Input, Select, Tabs, Textarea } from "@/components/ui";
import { parseContent, type ArtifactContent } from "@/lib/artifacts/content";
import {
  ARTIFACT_KINDS, COLOR_ROLES, COVERS, FONTS, SPACINGS, deriveDark, readabilityWarnings, validateTokens,
  type ArtifactKind, type DesignTokens, type Templates,
} from "@/lib/design-sets/tokens";
import { useT } from "@/lib/i18n/client";
import { ArtifactPreview } from "./artifact-preview";

export type EditableSet = {
  id: string | null;
  name: string;
  description: string;
  tokens: DesignTokens;
  templates: Templates;
  builtin: boolean;
  version: number;
  sourceUrl?: string | null;
};

type TFn = ReturnType<typeof useT>;

/** Sample content for the live preview, in the reader's language. */
function sample(t: TFn): ArtifactContent {
  const s = (k: string) => t(`artifacts.setEditor.sample.${k}`);
  const now = new Date();
  const d = (m: number) => new Date(now.getFullYear(), now.getMonth() + m, 12).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return parseContent({
    subtitle: t("artifacts.setEditor.sampleSubtitle"),
    sections: [
      { id: "a", title: s("s1"), blocks: [{ id: "a1", type: "text", text: s("s1text").replace("[1]", "[^c1]").replace("[2]", "[^c2]") }] },
      { id: "b", title: s("s2"), blocks: [{ id: "b1", type: "facts", items: [
        { label: s("f1"), value: s("v1"), cites: ["c1"] }, { label: s("f2"), value: s("v2"), cites: ["c2"] }, { label: s("f3"), value: s("v3"), cites: ["c3"] },
      ] }] },
      { id: "c", title: s("s3"), blocks: [{ id: "c1", type: "timeline", items: [
        { when: d(0), label: s("e1"), detail: "", cites: ["c4"] }, { when: d(1), label: s("e2"), detail: "", cites: ["c4"] }, { when: d(2), label: s("e3"), detail: "", cites: ["c4"] },
      ] }] },
      { id: "d", title: s("s4"), blocks: [
        { id: "d1", type: "people", items: [{ name: s("p1"), role: s("r1"), cites: ["c2"] }, { name: s("p2"), role: s("r2"), cites: ["c3"] }] },
        { id: "d2", type: "quote", text: s("quote"), attribution: s("quoteBy"), cites: ["c2"] },
      ] },
    ],
    citations: [
      { id: "c1", kind: "source", label: s("c1"), quote: null }, { id: "c2", kind: "source", label: s("c2"), quote: null },
      { id: "c3", kind: "node", label: s("c3"), quote: null }, { id: "c4", kind: "source", label: s("c4"), quote: null },
    ],
  });
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-8 shrink-0 cursor-pointer rounded-md bg-transparent p-0" aria-label={label} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <input value={text} onChange={(e) => { setText(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase()); }}
        className="h-8 w-24 shrink-0 rounded-md bg-surface px-2 font-mono text-xs uppercase tabular-nums text-fg ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" aria-label={`${label} hex`} spellCheck={false} />
    </label>
  );
}

export function DesignSetEditor({ initial, canEdit, openSite, graphName }: { initial: EditableSet; canEdit: boolean; openSite?: boolean; graphName: string }) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState(initial.builtin ? `${initial.name} (2)` : initial.name);
  const [description, setDescription] = useState(initial.description);
  const [tokens, setTokens] = useState<DesignTokens>(initial.tokens);
  const [templates, setTemplates] = useState<Templates>(initial.templates);
  const [sourceUrl, setSourceUrl] = useState<string | null>(initial.sourceUrl ?? null);
  const [kind, setKind] = useState<ArtifactKind>("report");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<{ open: boolean; url: string; busy: boolean; notes: string[]; error: string | null; via?: string }>({ open: !!openSite, url: "", busy: false, notes: [], error: null });
  const content = useMemo(() => sample(t), [t]);
  const warnings = useMemo(() => readabilityWarnings(tokens), [tokens]);
  const isNew = !initial.id || initial.builtin;

  const setColor = (m: "light" | "dark", role: string, v: string) => setTokens((x) => ({ ...x, colors: { ...x.colors, [m]: { ...x.colors[m], [role]: v } } }));
  const tpl = templates[kind];
  const setTpl = (patch: Partial<Templates[ArtifactKind]>) => setTemplates((x) => ({ ...x, [kind]: { ...x[kind], ...patch } }));

  async function readSite() {
    setSite((s) => ({ ...s, busy: true, error: null, notes: [] }));
    const res = await fetch("/api/design-sets/from-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: site.url }) }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) { setSite((s) => ({ ...s, busy: false, error: body?.error ?? t("artifacts.error") })); return; }
    const p = body.proposal as { name: string; tokens: DesignTokens; notes: string[]; url: string; via: string };
    setTokens(p.tokens);
    if (isNew) setName(p.name);
    setSourceUrl(p.url);
    setSite((s) => ({ ...s, busy: false, notes: p.notes, via: p.via }));
  }

  async function save() {
    setError(null);
    setMsg(null);
    const check = validateTokens(tokens);
    if (!check.ok) { setError(check.errors[0]?.message ?? t("artifacts.error")); return; }
    setBusy(true);
    const url = isNew ? "/api/design-sets" : `/api/design-sets/${initial.id}`;
    const res = await fetch(url, {
      method: isNew ? "POST" : "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: description || null, tokens: check.tokens, templates, sourceUrl }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setBusy(false);
    if (!res?.ok) { setError(body?.error ?? t("artifacts.error")); return; }
    if (isNew) { router.push(`/artifacts/styles/${body.designSet.id}`); router.refresh(); return; }
    setMsg(t("artifacts.setEditor.savedVersion", { n: body.designSet.version }));
    router.refresh();
  }

  const fontOptions = FONTS.map((f) => <option key={f.family} value={f.family}>{f.family}</option>);

  return (
    <div className="mx-auto max-w-[1400px]">
      <Link href="/artifacts/styles" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" aria-hidden />{t("artifacts.sets.title")}</Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{isNew ? t("artifacts.setEditor.newTitle") : initial.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && <Button variant="secondary" onClick={() => setSite((s) => ({ ...s, open: !s.open }))}><Globe className="size-4" aria-hidden />{t("artifacts.sets.fromSite")}</Button>}
          {canEdit && <Button disabled={busy} onClick={() => void save()}>{isNew ? t("artifacts.setEditor.saveNew") : t("artifacts.setEditor.save")}</Button>}
        </div>
      </div>
      {initial.builtin && <p className="mb-4 text-sm text-muted">{t("artifacts.setEditor.builtinNote")}</p>}
      {error && <p role="alert" className="mb-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      {msg && <p role="status" className="mb-4 rounded-md bg-accent-tint px-3 py-2 text-sm text-accent">{msg}</p>}

      {site.open && canEdit && (
        <div className="mb-6 rounded-lg bg-surface p-4">
          <h2 className="text-lg font-semibold">{t("artifacts.site.title")}</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">{t("artifacts.site.lead")}</p>
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void readSite(); }}>
            <Input value={site.url} onChange={(e) => setSite((s) => ({ ...s, url: e.target.value }))} placeholder={t("artifacts.site.urlPlaceholder")}
              aria-label={t("artifacts.site.url")} className="max-w-md flex-1" inputMode="url" autoFocus />
            <Button type="submit" disabled={site.busy || site.url.trim().length < 3}><Wand2 className="size-4" aria-hidden />{site.busy ? t("artifacts.site.working") : t("artifacts.site.go")}</Button>
          </form>
          {site.error && <p role="alert" className="mt-2 text-sm text-danger">{site.error}</p>}
          {site.notes.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="font-medium">{t("artifacts.site.found")}</p>
              <ul className="mt-1 list-disc pl-5 text-muted">{site.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              {site.via === "mux" && <p className="mt-1 text-xs text-muted">{t("artifacts.site.viaMux")}</p>}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <fieldset disabled={!canEdit} className="grid min-w-0 content-start gap-7">
          <div className="grid gap-4">
            <Field label={t("artifacts.setEditor.name")}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
            <Field label={t("artifacts.setEditor.description")}><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("artifacts.setEditor.descriptionPlaceholder")} maxLength={300} /></Field>
          </div>

          <section>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">{t("artifacts.setEditor.colors")}</h2>
              <Tabs value={mode} onSelect={(m) => { setMode(m); setTheme(m); }} items={[{ value: "light", label: t("artifacts.setEditor.light") }, { value: "dark", label: t("artifacts.setEditor.dark") }]} />
            </div>
            <div className="grid gap-2">
              {COLOR_ROLES.map((r) => <ColorRow key={`${mode}-${r}`} label={t(`artifacts.setEditor.roles.${r}`)} value={tokens.colors[mode][r]} onChange={(v) => setColor(mode, r, v)} />)}
            </div>
            {mode === "dark" && (
              <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setTokens((x) => ({ ...x, colors: { ...x.colors, dark: deriveDark(x.colors.light) } }))}>
                <Sparkles className="size-3.5" aria-hidden />{t("artifacts.setEditor.deriveDark")}
              </Button>
            )}
            {warnings.length > 0 && (
              <div className="mt-3 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">
                <p className="font-medium">{t("artifacts.setEditor.warnings")}</p>
                <ul className="mt-1 list-disc pl-5">{warnings.map((w) => <li key={w.field}>{w.message}</li>)}</ul>
              </div>
            )}
          </section>

          <section className="grid gap-4">
            <h2 className="text-lg font-semibold">{t("artifacts.setEditor.fonts")}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("artifacts.setEditor.display")}><Select value={tokens.fonts.display} onChange={(e) => setTokens((x) => ({ ...x, fonts: { ...x.fonts, display: e.target.value } }))}>{fontOptions}</Select></Field>
              <Field label={t("artifacts.setEditor.body")}><Select value={tokens.fonts.body} onChange={(e) => setTokens((x) => ({ ...x, fonts: { ...x.fonts, body: e.target.value } }))}>{fontOptions}</Select></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`${t("artifacts.setEditor.scale")} ${tokens.scale.toFixed(3)}`} hint={t("artifacts.setEditor.scaleHint")}>
                <input type="range" min={1.1} max={1.6} step={0.005} value={tokens.scale} onChange={(e) => setTokens((x) => ({ ...x, scale: Number(e.target.value) }))} className="w-full accent-[var(--fg)]" />
              </Field>
              <Field label={`${t("artifacts.setEditor.baseSize")} ${tokens.baseSize}px`}>
                <input type="range" min={13} max={20} step={1} value={tokens.baseSize} onChange={(e) => setTokens((x) => ({ ...x, baseSize: Number(e.target.value) }))} className="w-full accent-[var(--fg)]" />
              </Field>
              <Field label={`${t("artifacts.setEditor.radius")} ${tokens.radius}px`}>
                <input type="range" min={0} max={24} step={1} value={tokens.radius} onChange={(e) => setTokens((x) => ({ ...x, radius: Number(e.target.value) }))} className="w-full accent-[var(--fg)]" />
              </Field>
              <Field label={t("artifacts.setEditor.spacing")}>
                <Select value={tokens.spacing} onChange={(e) => setTokens((x) => ({ ...x, spacing: e.target.value as DesignTokens["spacing"] }))}>
                  {SPACINGS.map((s) => <option key={s} value={s}>{t(`artifacts.setEditor.spacings.${s}`)}</option>)}
                </Select>
              </Field>
            </div>
          </section>

          <section className="grid gap-3">
            <h2 className="text-lg font-semibold">{t("artifacts.setEditor.logo")}</h2>
            <div className="flex flex-wrap items-center gap-3">
              {tokens.logo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={tokens.logo.src} alt={tokens.logo.alt} className="h-10 max-w-[180px] rounded bg-surface-2 object-contain p-1" />
                : <span className="text-sm text-muted">{t("artifacts.setEditor.logoNone")}</span>}
              <LogoPicker onPick={(id, title) => setTokens((x) => ({ ...x, logo: { src: `/api/files/${id}`, alt: title } }))} />
              {tokens.logo && <Button type="button" size="sm" variant="ghost" onClick={() => setTokens((x) => ({ ...x, logo: null }))}>{t("artifacts.setEditor.logoRemove")}</Button>}
            </div>
          </section>

          <Field label={t("artifacts.setEditor.tone")} hint={t("artifacts.setEditor.toneHint")}>
            <Textarea rows={3} value={tokens.tone} maxLength={400} onChange={(e) => setTokens((x) => ({ ...x, tone: e.target.value }))} />
          </Field>

          <section className="grid gap-3">
            <h2 className="text-lg font-semibold">{t("artifacts.setEditor.templates")}</h2>
            <p className="text-sm text-muted">{t(`artifacts.kinds.${kind}`)}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("artifacts.setEditor.cover")}>
                <Select value={tpl.cover} onChange={(e) => setTpl({ cover: e.target.value as Templates[ArtifactKind]["cover"] })}>
                  {COVERS.map((c) => <option key={c} value={c}>{t(`artifacts.setEditor.covers.${c}`)}</option>)}
                </Select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={tpl.showLogo} onChange={(e) => setTpl({ showLogo: e.target.checked })} className="size-4 accent-[var(--fg)]" />
                {t("artifacts.setEditor.showLogo")}
              </label>
            </div>
            <Field label={t("artifacts.setEditor.footer")}>
              <Input value={tpl.footer} maxLength={120} placeholder={t("artifacts.setEditor.footerPlaceholder")} onChange={(e) => setTpl({ footer: e.target.value })} />
            </Field>
          </section>
        </fieldset>

        <div className="min-w-0">
          <div className="lg:sticky lg:top-6">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Tabs value={kind} onSelect={setKind} className="max-w-full overflow-x-auto" items={ARTIFACT_KINDS.map((k) => ({ value: k, label: t(`artifacts.kinds.${k}`) }))} />
              <Tabs value={theme} onSelect={setTheme} items={[{ value: "light", label: t("artifacts.setEditor.light") }, { value: "dark", label: t("artifacts.setEditor.dark") }]} />
            </div>
            <div className="max-h-[calc(100vh-8rem)] overflow-auto rounded-lg" aria-label={t("artifacts.setEditor.preview")}>
              <ArtifactPreview kind={kind} title={t("artifacts.setEditor.sampleTitle")} content={content} tokens={tokens} template={templates[kind]}
                byline={graphName} theme={theme} scope="ds" className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--line)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LogoPicker({ onPick }: { onPick: (id: string, title: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    if (!open || items) return;
    void fetch("/api/library?type=image&limit=40").then((r) => (r.ok ? r.json() : { items: [] })).then((b) => setItems((b.items ?? []).map((i: { id: string; title: string }) => ({ id: i.id, title: i.title })))).catch(() => setItems([]));
  }, [open, items]);
  return (
    <div className="relative">
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{t("artifacts.setEditor.logoPick")}</Button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg bg-surface p-2 shadow-float">
          {!items ? <p className="text-sm text-muted">…</p> : !items.length ? <p className="text-sm text-muted">{t("artifacts.blocks.noImages")}</p> : (
            <div className="grid grid-cols-4 gap-1.5">
              {items.map((i) => (
                <button key={i.id} type="button" title={i.title} onClick={() => { onPick(i.id, i.title); setOpen(false); }} className="aspect-square overflow-hidden rounded-md bg-surface-2 hover:ring-2 hover:ring-accent">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/files/${i.id}`} alt={i.title} className="size-full object-contain" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
