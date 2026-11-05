"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, Globe, Plus } from "lucide-react";
import { Badge, Button, PageHeader, Section, buttonClass } from "@/components/ui";
import { fontStack, googleFontsHref, type DesignSetView } from "@/lib/design-sets/tokens";
import { useT } from "@/lib/i18n/client";

function Swatches({ s }: { s: DesignSetView }) {
  const l = s.tokens.colors.light, d = s.tokens.colors.dark;
  return (
    <span className="flex shrink-0 overflow-hidden rounded-md shadow-[0_0_0_1px_var(--line)]" aria-hidden>
      {[l.bg, l.ink, l.accent, l.accent2, d.bg, d.accent].map((c, i) => <span key={i} className="h-10 w-5" style={{ background: c }} />)}
    </span>
  );
}

function Row({ s, isDefault, canEdit, onDefault, onArchive }: { s: DesignSetView; isDefault: boolean; canEdit: boolean; onDefault: () => void; onArchive?: () => void }) {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center gap-4 rounded-md px-2 py-3 hover:bg-surface-2/50">
      <Swatches s={s} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <Link href={`/artifacts/styles/${s.id}`} className="font-medium hover:underline" style={{ fontFamily: fontStack(s.tokens.fonts.display) }}>{s.name}</Link>
          {isDefault && <Badge tone="accent"><Check className="size-3" aria-hidden />{t("artifacts.sets.isDefault")}</Badge>}
          {!s.builtin && <span className="text-xs text-muted tabular-nums">{t("artifacts.sets.version", { n: s.version })}</span>}
        </span>
        <span className="mt-0.5 block text-sm text-muted">{s.description || `${s.tokens.fonts.display} / ${s.tokens.fonts.body}`}</span>
      </span>
      <span className="flex flex-wrap gap-1">
        {canEdit && !isDefault && <Button size="sm" variant="ghost" onClick={onDefault}>{t("artifacts.sets.makeDefault")}</Button>}
        {canEdit && <Link href={s.builtin ? `/artifacts/styles/new?from=${s.id}` : `/artifacts/styles/${s.id}`} className={buttonClass("secondary", "sm")}>{s.builtin ? t("artifacts.sets.copy") : t("artifacts.sets.edit")}</Link>}
        {canEdit && onArchive && <Button size="sm" variant="ghost" onClick={onArchive}>{t("artifacts.sets.archive")}</Button>}
      </span>
    </li>
  );
}

/** `hub` is the Artifacts hub header (Styles tab); without it the list has its own back link and title. */
export function DesignSetList({ sets, defaultId, canEdit, graphName, hub }: { sets: DesignSetView[]; defaultId: string; canEdit: boolean; graphName: string; hub?: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const [def, setDef] = useState(defaultId);
  const [error, setError] = useState<string | null>(null);
  const builtins = sets.filter((s) => s.builtin);
  const custom = sets.filter((s) => !s.builtin);
  const fonts = googleFontsHref(sets.map((s) => s.tokens.fonts.display));

  async function makeDefault(id: string) {
    setError(null);
    const res = await fetch("/api/design-sets/default", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ designSetId: id }) }).catch(() => null);
    if (res?.ok) setDef(id); else setError((await res?.json().catch(() => null))?.error ?? t("artifacts.error"));
  }
  async function archive(id: string) {
    if (!window.confirm(t("artifacts.sets.archiveConfirm"))) return;
    const res = await fetch(`/api/design-sets/${id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) router.refresh(); else setError((await res?.json().catch(() => null))?.error ?? t("artifacts.error"));
  }

  return (
    <div className={hub ? undefined : "mx-auto max-w-4xl"}>
      <link rel="stylesheet" href={fonts} precedence="default" />
      {hub ? <>
        {hub}
        {canEdit && (
          <div className="mb-8 flex max-w-4xl flex-wrap items-center gap-2">
            <Link href="/artifacts/styles/new" className={buttonClass("secondary")}><Plus className="size-4" aria-hidden />{t("artifacts.sets.new")}</Link>
            <Link href="/artifacts/styles/new?site=1" className={buttonClass("ghost")}><Globe className="size-4" aria-hidden />{t("artifacts.sets.fromSite")}</Link>
          </div>
        )}
      </> : <>
        <Link href="/artifacts" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" aria-hidden />{t("artifacts.editor.back")}</Link>
        <PageHeader title={t("artifacts.sets.title")} lead={t("artifacts.sets.lead", { graph: graphName })}
          actions={canEdit ? <>
            <Link href="/artifacts/styles/new?site=1" className={buttonClass("secondary")}><Globe className="size-4" aria-hidden />{t("artifacts.sets.fromSite")}</Link>
            <Link href="/artifacts/styles/new" className={buttonClass("primary")}><Plus className="size-4" aria-hidden />{t("artifacts.sets.new")}</Link>
          </> : undefined} />
      </>}
      {error && <p role="alert" className="mb-4 max-w-4xl rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="grid max-w-4xl gap-10">
        <Section title={t("artifacts.sets.builtin")}>
          <ul className="-mx-2">{builtins.map((s) => <Row key={s.id} s={s} isDefault={def === s.id} canEdit={canEdit} onDefault={() => void makeDefault(s.id)} />)}</ul>
        </Section>
        <Section title={t("artifacts.sets.custom")}>
          {custom.length === 0
            ? <p className="text-sm text-muted">{t("artifacts.sets.noCustom")}</p>
            : <ul className="-mx-2">{custom.map((s) => <Row key={s.id} s={s} isDefault={def === s.id} canEdit={canEdit} onDefault={() => void makeDefault(s.id)} onArchive={() => void archive(s.id)} />)}</ul>}
        </Section>
      </div>
    </div>
  );
}
