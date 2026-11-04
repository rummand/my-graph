"use client";
import { useState } from "react";
import { motion } from "motion/react";
import { clsx } from "clsx";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, PersonChip, NodeChip } from "@/components/ui";
import { MentionText } from "@/components/mention";
import { formatAgo, useLocale, useT, type TFn, type Locale } from "@/lib/i18n/client";
import type { MemoryView } from "@/lib/memory/types";
import { MEMORY_MAX_CHARS } from "@/lib/memory/pure";
import { draftFrom, MentionField, storedFrom, type MentionDraft } from "./mention-field";
import { variantOf } from "./variant";

/** "Used 3 minutes ago" / "Brugt 3 minutter siden". */
export function usedLabel(m: Pick<MemoryView, "lastUsedAt" | "status">, t: TFn, locale: Locale): string {
  if (m.status === "pending") return t("memory.item.notUsedPending");
  if (!m.lastUsedAt) return t("memory.item.notUsedYet");
  return t("memory.item.used", { time: formatAgo(m.lastUsedAt, locale) });
}

/** One memory: what it says, who it applies to, where it came from, when it was last used, and edit / pause / forget. */
export function MemoryItem({ m, onUpdate, onRemove, hideAbout, compact, graphKind }: {
  m: MemoryView;
  /** The current graph's kind, for the "parents" visibility label. */
  graphKind?: string | null;
  onUpdate: (id: string, patch: { text?: string; status?: "active" | "paused" }) => Promise<unknown>;
  onRemove: (m: MemoryView) => void;
  /** On a person's page every memory is about them; don't repeat their chip. */
  hideAbout?: string;
  compact?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MentionDraft>(() => draftFrom(m.text));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = m.status === "paused";
  const about = m.about.filter((a) => a.id !== hideAbout);

  async function run(patch: { text?: string; status?: "active" | "paused" }) {
    setBusy(true); setError(null);
    try {
      await onUpdate(m.id, patch);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("memory.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const text = storedFrom({ ...draft, text: draft.text.trim() });
    if (text === m.text) { setEditing(false); return; }
    if (draft.text.trim().length < 2) { setError(t("memory.item.writeSomething")); return; }
    if (await run({ text })) setEditing(false);
  }

  const actions = m.canEdit ? (
<div className={clsx("flex shrink-0 items-center gap-0.5", compact ? "text-muted" : "opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100")}>
              <IconButton label={t("memory.item.edit")} onClick={() => { setDraft(draftFrom(m.text)); setEditing(true); }}><Pencil className="size-4" /></IconButton>
              {m.status !== "pending" && (
                <IconButton label={paused ? t("memory.item.resume") : t("memory.item.pause")} disabled={busy}
                  onClick={() => void run({ status: paused ? "active" : "paused" })}>
                  {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                </IconButton>
              )}
              <IconButton label={t("memory.item.forget")} onClick={() => onRemove(m)}><Trash2 className="size-4" /></IconButton>
            </div>
  ) : null;

  return (
    <motion.li id={`memory-${m.id}`} layout="position" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={clsx("group list-none scroll-mt-24 target:rounded-md target:bg-accent-tint", compact ? "py-2.5" : "py-3.5")}>
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-2">
          <MentionField autoFocus aria-label={t("memory.item.textLabel")} rows={2} maxLength={MEMORY_MAX_CHARS} draft={draft}
            onDraft={setDraft}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setEditing(false); setDraft(draftFrom(m.text)); setError(null); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            }} />
          <div className="flex items-center gap-2">
            <Button size="sm" type="submit" disabled={busy}>{busy ? t("memory.item.saving") : t("memory.item.save")}</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setDraft(draftFrom(m.text)); setError(null); }}>{t("memory.item.cancel")}</Button>
            {error && <span role="alert" className="text-sm text-danger">{error}</span>}
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={clsx("text-[15px] leading-snug", paused && "text-muted")}><MentionText text={m.text} /></p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
              {about.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                  {about.map((a) => a.type === "person"
                    ? <PersonChip key={a.id} id={a.id} name={a.label} href={`/people/${a.id}`} />
                    : <NodeChip key={a.id} type={a.type} label={a.label} href={`/node/${a.id}`} />)}
                </span>
              )}
              {m.from.href
                ? <a href={m.from.href} className="text-accent hover:underline">{m.from.label}</a>
                : <span>{m.from.label}</span>}
              <span suppressHydrationWarning>{usedLabel(m, t, locale)}</span>
              {m.visibility === "private" && <span>{t("memory.visibility.privateShort")}</span>}
              {m.visibility === "parents" && <span>{t(`memory.visibility.parents.${variantOf(graphKind)}`)}</span>}
              {paused && <Badge>{t("memory.item.paused")}</Badge>}
            </div>
            {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
            {compact && actions && <div className="-ml-2 mt-1">{actions}</div>}
          </div>
          {!compact && actions}
        </div>
      )}
    </motion.li>
  );
}
