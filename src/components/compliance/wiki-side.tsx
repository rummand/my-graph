"use client";
/**
 * The wiki page's quiet column and read view: "Check against" (the graph's default corpora, a choice for this page,
 * or nothing) and, while reading, the last check's strip.
 */
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Scale } from "lucide-react";
import { Select } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { countsOf, getChoice, putChoice, storedFindings, type Choice, type TargetType } from "./api";
import { ComplianceStrip, type StripState } from "./strip";

type Mode = "default" | "custom" | "none";

export function CheckAgainst({ pageId, canEdit, targetType = "wiki" }: { pageId: string; canEdit: boolean; targetType?: TargetType }) {
  const t = useT();
  const id = useId();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void getChoice(targetType, pageId).then((r) => { if (live && r.ok) setChoice(r.data); });
    return () => { live = false; };
  }, [targetType, pageId]);

  if (!choice) return null;
  const corpora = choice.corpora.filter((c) => c.status === "active" || c.status === "draft");
  if (!corpora.length && !choice.own) return null;
  const mode: Mode = choice.own === null ? "default" : choice.own.length ? "custom" : "none";
  const names = (ids: string[]) => corpora.filter((c) => ids.includes(c.id)).map((c) => c.name).join(", ");
  const defaultIds = choice.graphDefault ?? corpora.filter((c) => c.checkByDefault && c.status === "active").map((c) => c.id);

  async function save(ids: string[] | null) {
    setBusy(true);
    const r = await putChoice(targetType, pageId, ids);
    setBusy(false);
    if (r.ok) { setChoice(r.data); setSaved(true); setTimeout(() => setSaved(false), 1500); }
  }

  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="mb-2 flex items-center gap-1.5 font-semibold"><Scale aria-hidden className="size-4 text-muted" />{t("compliance.checkAgainst.title")}</h2>
      {canEdit ? (
        <>
          <label htmlFor={`${id}-mode`} className="sr-only">{t("compliance.checkAgainst.title")}</label>
          <Select id={`${id}-mode`} className="h-8 text-sm" value={mode} disabled={busy}
            onChange={(e) => {
              const m = e.target.value as Mode;
              void save(m === "default" ? null : m === "none" ? [] : choice.effective.length ? choice.effective : corpora.map((c) => c.id));
            }}>
            <option value="default">{t("compliance.checkAgainst.graphDefault")}</option>
            <option value="custom">{t("compliance.checkAgainst.custom")}</option>
            <option value="none">{t("compliance.checkAgainst.none")}</option>
          </Select>
          {mode === "default" && <p className="mt-2 text-muted">{names(defaultIds) || t("compliance.checkAgainst.noCorpora")}</p>}
          {mode === "custom" && (
            <fieldset className="mt-2 grid gap-1" disabled={busy}>
              <legend className="sr-only">{t("compliance.checkAgainst.custom")}</legend>
              {corpora.map((c) => {
                const on = (choice.own ?? []).includes(c.id);
                return (
                  <label key={c.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface-2">
                    <input type="checkbox" checked={on} className="accent-[var(--color-fg)]"
                      onChange={() => void save(on ? (choice.own ?? []).filter((x) => x !== c.id) : [...(choice.own ?? []), c.id])} />
                    <span className="min-w-0 truncate">{c.name}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <p className="mt-1 h-4 text-xs text-muted" aria-live="polite">{saved ? t("compliance.checkAgainst.saved") : ""}</p>
        </>
      ) : (
        <p className="text-muted">{mode === "none" ? t("compliance.checkAgainst.none") : names(choice.effective) || t("compliance.checkAgainst.noCorpora")}</p>
      )}
      <Link href="/corpora" className="text-xs text-accent hover:underline">{t("compliance.checkAgainst.manage")}</Link>
    </section>
  );
}

/** While reading a page: what the last check found (editing re-checks it live). */
export function ReadCompliance({ pageId, canEdit, onEdit }: { pageId: string; canEdit: boolean; onEdit?: () => void }) {
  const [state, setState] = useState<StripState | null>(null);
  useEffect(() => {
    let live = true;
    void storedFindings("wiki", pageId).then((r) => {
      if (!live || !r.ok || !r.data.run) return;
      setState({ phase: "idle", corpora: r.data.run.corpora, findings: r.data.findings, counts: countsOf(r.data.findings), status: null, checked: true });
    });
    return () => { live = false; };
  }, [pageId]);
  if (!state || (!state.findings.length && !state.corpora.length)) return null;
  return (
    <div className="mt-5 max-w-[68ch] font-sans">
      <ComplianceStrip state={state} canEdit={canEdit} onSuggest={onEdit ? () => onEdit() : undefined}
        onChanged={(findings) => setState((s) => s && { ...s, findings, counts: countsOf(findings) })} />
    </div>
  );
}
