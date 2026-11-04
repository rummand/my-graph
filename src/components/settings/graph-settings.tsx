"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { clsx } from "clsx";
import { Check } from "lucide-react";
import { Button, Input, Select, buttonClass } from "@/components/ui";
import { GraphDot } from "@/components/graphs/bits";
import { graphApi } from "@/components/graphs/client-api";
import { GRAPH_PALETTE, graphStyle } from "@/components/graphs/describe";
import { useT } from "@/lib/i18n/client";
import { ErrorNote, Notice } from "@/app/login/notes";

type Kind = "family" | "personal" | "work" | "shared" | "other" | "partner" | "project";
const KINDS: Exclude<Kind, "family">[] = ["personal", "work", "partner", "project", "shared", "other"];

export type GraphSettingsView = {
  id: string; name: string; color: number; kind: Kind; isFamily: boolean; canEdit: boolean;
  memberCount: number; ownerName: string | null;
};

/** The current graph's name, colour and purpose. The owner edits; everyone else sees who can. */
export function GraphSettings({ g }: { g: GraphSettingsView }) {
  const router = useRouter();
  const t = useT();
  const [name, setName] = useState(g.name);
  const [color, setColor] = useState(g.color);
  const [kind, setKind] = useState<Kind>(g.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== g.name || color !== g.color || kind !== g.kind;
  const palette = GRAPH_PALETTE.some((p) => p.hue === g.color) ? GRAPH_PALETTE : [{ hue: g.color, name: "" }, ...GRAPH_PALETTE];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await graphApi(`/api/graphs/${g.id}`, "PATCH", {
        ...(name.trim() !== g.name ? { name: name.trim() } : {}),
        ...(color !== g.color ? { color } : {}),
        ...(!g.isFamily && kind !== g.kind ? { kind } : {}),
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted">{t("settings.graph.members", { count: g.memberCount })}</p>
      <div className="flex flex-wrap gap-2">
        <Link href="/graphs" className={buttonClass("ghost", "sm")}>{t("settings.graph.manageMembers")}</Link>
        {g.canEdit && <Button type="submit" disabled={busy || !dirty || !name.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>}
      </div>
    </div>
  );

  if (!g.canEdit) {
    return (
      <div>
        <div className="flex items-center gap-3">
          <GraphDot hue={g.color} size={12} />
          <p className="min-w-0 truncate font-medium">{g.name}</p>
          <span className="text-sm text-muted">{t(`graphs.kinds.${g.kind}`)}</span>
        </div>
        <p className="mt-3 text-sm text-muted">{g.ownerName ? t("settings.graph.onlyOwner", { owner: g.ownerName }) : t("settings.graph.onlyOwnerNoName")}</p>
        {footer}
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="g-name" className="mb-1.5 block text-sm font-medium">{t("settings.graph.name")}</label>
          <Input id="g-name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        </div>
        <div>
          <label htmlFor="g-kind" className="mb-1.5 block text-sm font-medium">{t("settings.graph.kind")}</label>
          {g.isFamily ? (
            <p id="g-kind" className="flex h-9 items-center text-sm text-muted">{t("settings.graph.kindFamily")}</p>
          ) : (
            <Select id="g-kind" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setSaved(false); }} className="w-full">
              {KINDS.map((k) => <option key={k} value={k}>{t(`graphs.kinds.${k}`)}</option>)}
            </Select>
          )}
        </div>
      </div>
      <fieldset className="mt-4">
        <legend className="mb-1.5 text-sm font-medium">{t("settings.graph.colour")}</legend>
        <div className="flex flex-wrap gap-1.5">
          {palette.map((p) => {
            const on = p.hue === color;
            return (
              <label key={p.hue} title={p.name || undefined} style={graphStyle(p.hue) as CSSProperties}
                className={clsx("relative flex size-9 cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  on ? "ring-2 ring-fg ring-offset-2 ring-offset-surface" : "hover:brightness-95")}>
                <input type="radio" name="g-color" value={p.hue} checked={on} onChange={() => { setColor(p.hue); setSaved(false); }} className="sr-only" aria-label={p.name || String(p.hue)} />
                <span aria-hidden className="size-7 rounded-full bg-[var(--g)]" />
                {on && <Check size={14} className="absolute text-white" aria-hidden />}
              </label>
            );
          })}
        </div>
      </fieldset>
      <ErrorNote message={error} className="mt-4" />
      {saved && <Notice message={t("settings.graph.saved")} className="mt-4" />}
      {footer}
    </form>
  );
}
