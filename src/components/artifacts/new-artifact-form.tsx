"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { FileText, Newspaper, Presentation, ScrollText, UserRound } from "lucide-react";
import { Button, Field, Input, PageHeader, Select } from "@/components/ui";
import { MentionTextarea, type PickedMention } from "@/components/mention";
import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/design-sets/tokens";
import { useT } from "@/lib/i18n/client";

const KIND_ICON = { report: FileText, one_pager: Newspaper, deck: Presentation, brief: ScrollText, profile: UserRound } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function NewArtifactForm({ graphName, sets, defaultSetId, initialKind, initialAbout }: {
  graphName: string;
  sets: { id: string; name: string }[];
  defaultSetId: string;
  initialKind?: string;
  initialAbout?: { nodeId: string; label: string };
}) {
  const t = useT();
  const router = useRouter();
  const about0 = initialAbout && UUID.test(initialAbout.nodeId) ? initialAbout : undefined;
  const [kind, setKind] = useState<ArtifactKind>((ARTIFACT_KINDS as readonly string[]).includes(initialKind ?? "") ? (initialKind as ArtifactKind) : "report");
  const [text, setText] = useState(about0 ? `@${about0.label} ` : "");
  const [mentions, setMentions] = useState<PickedMention[]>(about0 ? [{ label: about0.label, nodeId: about0.nodeId }] : []);
  const [title, setTitle] = useState(about0?.label ?? "");
  const [titleTouched, setTitleTouched] = useState(!!about0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [setId, setSetId] = useState(defaultSetId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultName = sets.find((s) => s.id === defaultSetId)?.name ?? "";

  const onText = (v: string, m: PickedMention[]) => {
    setText(v);
    setMentions(m);
    if (!titleTouched) setTitle(m[0]?.label ?? v.replace(/@/g, "").trim().split(/[.?!\n]/)[0]?.slice(0, 80) ?? "");
  };

  async function submit(blank: boolean) {
    setError(null);
    const question = text.replace(/@/g, "").trim();
    const finalTitle = title.trim() || mentions[0]?.label || question.slice(0, 80);
    if (!finalTitle) { setError(t("artifacts.form.needAbout")); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind, title: finalTitle, designSetId: setId, blank,
          query: { about: mentions.map((m) => ({ nodeId: m.nodeId, label: m.label })), question, from: from || null, to: to || null, text },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? t("artifacts.error")); setBusy(false); return; }
      router.push(`/artifacts/${body.artifact.id}`);
    } catch {
      setError(t("artifacts.error"));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("artifacts.form.title")} lead={t("artifacts.form.lead", { graph: graphName })} />
      <form className="grid gap-8" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <fieldset>
          <legend className="mb-3 text-lg font-semibold">{t("artifacts.form.kind")}</legend>
          <div className="grid gap-1 sm:grid-cols-2" role="radiogroup">
            {ARTIFACT_KINDS.map((k) => {
              const Icon = KIND_ICON[k];
              const on = k === kind;
              return (
                <label key={k} className={clsx("flex cursor-pointer items-start gap-3 rounded-lg px-3 py-3 transition-colors",
                  on ? "bg-surface ring-2 ring-inset ring-fg" : "hover:bg-surface-2/70")}>
                  <input type="radio" name="kind" value={k} checked={on} onChange={() => setKind(k)} className="sr-only" />
                  <Icon className={clsx("mt-0.5 size-5 shrink-0", on ? "text-fg" : "text-muted")} aria-hidden />
                  <span>
                    <span className="block font-medium">{t(`artifacts.kinds.${k}`)}</span>
                    <span className="block text-sm text-muted">{t(`artifacts.kindHints.${k}`)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">{t("artifacts.form.about")}</span>
            <MentionTextarea value={text} mentions={mentions} onValueChange={onText} rows={3}
              placeholder={t("artifacts.form.aboutPlaceholder")}
              className="w-full rounded-md bg-surface px-3 py-2 text-[15px] leading-relaxed ring-1 ring-inset ring-line placeholder:text-muted/80 focus:outline-none focus:ring-2 focus:ring-accent" />
            <span className="mt-1.5 block text-sm text-muted">{t("artifacts.form.aboutHint")}</span>
          </label>
          <Field label={t("artifacts.form.name")} hint={t("artifacts.form.nameHint")}>
            <Input value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} placeholder={t("artifacts.form.namePlaceholder")} maxLength={200} />
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">{t("artifacts.form.range")}</legend>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-2 text-sm text-muted">{t("artifacts.form.from")}
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto tabular-nums" /></label>
              <label className="flex items-center gap-2 text-sm text-muted">{t("artifacts.form.to")}
                <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-auto tabular-nums" /></label>
            </div>
            <p className="mt-1.5 text-sm text-muted">{t("artifacts.form.rangeHint")}</p>
          </fieldset>
          <Field label={t("artifacts.form.design")} hint={t("artifacts.form.designHint", { graph: graphName, set: defaultName })}>
            <Select value={setId} onChange={(e) => setSetId(e.target.value)} className="sm:max-w-xs">
              {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>{busy ? t("artifacts.form.working") : t("artifacts.form.submit")}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void submit(true)}>{t("artifacts.form.blank")}</Button>
        </div>
      </form>
    </div>
  );
}
