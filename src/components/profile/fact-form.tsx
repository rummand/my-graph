"use client";
/**
 * Writing a fact on a profile: "Add a pet" → name (an existing thing, or a new one) and what kind it is. It becomes a
 * change set the person authors and delivers at once (POST /api/profile/:id/facts), so it shows in history and can be
 * rolled back. If the graph's model needs a parent's say first, it waits as a proposal instead.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Plus } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { fetchMentionables } from "@/components/mention/api";
import type { Mentionable } from "@/lib/mentions";
import { useT } from "@/lib/i18n/client";
import { kindName, relLabel } from "@/lib/people/words";
import { kindKeyOf, presetFor } from "@/lib/profile/presets";
import type { FactPresetKey, ProfileView } from "@/lib/profile/types";

const EASE = [0.22, 1, 0.36, 1] as const;
const TYPES = ["person", "organization", "project", "place", "event", "topic", "thing"] as const;

export type FactAdded = { status: "delivered" | "proposed"; changeSetId: string; otherId: string; edgeId: string; otherLabel: string; otherType: string; phrase: string };

export function FactForm({ profile, preset, onDone, onCancel }: { profile: ProfileView; preset: FactPresetKey; onDone: (r: FactAdded) => void; onCancel: () => void }) {
  const t = useT();
  const def = preset === "relation" ? null : presetFor(preset, profile.node.type);
  const [relValue, setRelValue] = useState(def ? `${def.relation}:${def.direction}` : "");
  const rel = def ? null : profile.relations.find((r) => `${r.key}:${r.direction}` === relValue) ?? null;
  const [otherType, setOtherType] = useState<string>(def?.otherType ?? "person");
  const allowedTypes = useMemo(() => (rel ? (rel.otherTypes.length ? rel.otherTypes : [...TYPES]) : def ? [def.otherType] : [...TYPES]).filter((x) => (TYPES as readonly string[]).includes(x)), [rel, def]);
  useEffect(() => { if (allowedTypes.length && !allowedTypes.includes(otherType)) setOtherType(allowedTypes[0]); }, [allowedTypes, otherType]);

  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Mentionable | null>(null);
  const [kindText, setKindText] = useState("");
  const [options, setOptions] = useState<Mentionable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.querySelector<HTMLInputElement>("input[name=fact-name]")?.focus(); }, []);

  useEffect(() => {
    if (picked || name.trim().length < 1) { setOptions([]); return; }
    let live = true;
    const id = window.setTimeout(async () => {
      const found = await fetchMentionables(name.trim(), 8);
      if (live) setOptions(found.filter((m) => m.type === otherType && m.nodeId !== profile.node.id).slice(0, 5));
    }, 180);
    return () => { live = false; window.clearTimeout(id); };
  }, [name, picked, otherType, profile.node.id]);

  const first = profile.node.label.split(" ")[0];
  const phrase = def
    ? t(`profile.preset.${preset}.phrase`, { name: first })
    : rel ? relLabel(t, rel.phrase) : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const relation = def?.relation ?? rel?.key;
    const direction = def?.direction ?? rel?.direction;
    if (!relation || !direction) { setError(t("profile.fact.pickRelation")); return; }
    const label = name.trim();
    if (!picked && !label) { setError(t("profile.fact.nameNeeded")); return; }
    const kindLabel = def?.namedKind && kindText.trim() ? kindText.trim() : null;
    const kind = kindLabel ? kindKeyOf(kindLabel) : def?.kind ?? null;
    setBusy(true);
    try {
      const res = await fetch(`/api/profile/${profile.node.id}/facts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          relation, direction,
          other: picked ? { id: picked.nodeId } : { label, type: otherType, kind, kindLabel: kindLabel ?? (def?.kindDef?.label ?? null) },
          ...(def?.relationDef ? { relationDef: def.relationDef } : {}),
          ...(def?.kindDef ? { kindDef: def.kindDef } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? t("profile.fact.failed")); return; }
      const out: FactAdded = {
        ...data, otherLabel: picked?.label ?? label, otherType: picked?.type ?? otherType,
        phrase: kindLabel && def?.namedKind ? t("profile.phrase.has", { what: kindLabel.toLowerCase() }) : phrase,
      };
      if (data.status === "proposed") { setWaiting(data.changeSetId); return; }
      onDone(out);
    } catch { setError(t("profile.fact.failed")); } finally { setBusy(false); }
  }

  if (waiting) {
    return (
      <div className="mt-3 rounded-lg bg-[var(--warn-tint)] p-4 text-sm" role="status">
        <p>{t("profile.fact.waiting")}</p>
        <div className="mt-2 flex gap-2">
          <Link href={`/changes/${waiting}`} className="text-accent hover:underline">{t("profile.fact.openProposal")}</Link>
          <button type="button" className="text-muted hover:text-fg" onClick={onCancel}>{t("profile.fact.close")}</button>
        </div>
      </div>
    );
  }

  return (
    <motion.form ref={formRef} onSubmit={submit} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
      <div className="mt-3 grid gap-3 rounded-lg bg-surface p-4 text-sm sm:grid-cols-2">
        {!def && (
          <Field label={t("profile.fact.relation", { name: first })} className="sm:col-span-2">
            <Select value={relValue} onChange={(e) => setRelValue(e.target.value)} required>
              <option value="">{t("profile.fact.choose")}</option>
              {profile.relations.map((r) => <option key={`${r.key}:${r.direction}`} value={`${r.key}:${r.direction}`}>{relLabel(t, r.phrase)}</option>)}
            </Select>
          </Field>
        )}
        {!def && allowedTypes.length > 1 && (
          <Field label={t("profile.fact.whatIsIt")}>
            <Select value={otherType} onChange={(e) => { setOtherType(e.target.value); setPicked(null); }}>
              {allowedTypes.map((x) => <option key={x} value={x}>{t(`profile.type.${x}`)}</option>)}
            </Select>
          </Field>
        )}
        <div className="relative">
          <Field label={def ? t(`profile.preset.${preset}.name`) : t("profile.fact.name")}>
            <Input name="fact-name" value={picked ? picked.label : name} autoComplete="off"
              onChange={(e) => { setPicked(null); setName(e.target.value); }}
              placeholder={def ? t(`profile.preset.${preset}.placeholder`) : ""} />
          </Field>
          {options.length > 0 && !picked && (
            <ul role="listbox" aria-label={t("profile.fact.existing")} className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg bg-surface p-1 shadow-float">
              {options.map((m) => (
                <li key={m.nodeId}>
                  <button type="button" role="option" aria-selected={false} className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onMouseDown={(e) => { e.preventDefault(); setPicked(m); setOptions([]); }}>
                    <span className="truncate">{m.label}</span>
                    <span className="shrink-0 text-xs text-muted">{m.kindLabel ? kindName(t, m.kindLabel) : m.typeLabel}</span>
                  </button>
                </li>
              ))}
              <li className="px-2.5 py-1 text-xs text-muted"><Plus aria-hidden className="mr-1 inline size-3" />{t("profile.fact.orNew", { name: name.trim() })}</li>
            </ul>
          )}
        </div>
        {def?.namedKind && !picked && (
          <Field label={t(`profile.preset.${preset}.kind`)}>
            <Input value={kindText} onChange={(e) => setKindText(e.target.value)} placeholder={t(`profile.preset.${preset}.kindPlaceholder`)} />
          </Field>
        )}
        {phrase && (picked || name.trim()) && (
          <p className="text-muted sm:col-span-2">
            {t("profile.fact.willRead")} <span className="text-fg">{def?.namedKind && kindText.trim() ? t("profile.phrase.has", { what: kindText.trim().toLowerCase() }) : phrase}: {picked?.label ?? name.trim()}</span>
          </p>
        )}
        {!profile.canGrowModel && def?.relationDef && <p className="text-xs text-muted sm:col-span-2">{t("profile.fact.modelNote")}</p>}
        {error && <p role="alert" className="text-danger sm:col-span-2">{error}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onCancel}>{t("profile.fact.cancel")}</Button>
          <Button type="submit" disabled={busy}>{busy ? t("profile.fact.adding") : t("profile.fact.add")}</Button>
        </div>
      </div>
    </motion.form>
  );
}
