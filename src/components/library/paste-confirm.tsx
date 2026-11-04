"use client";
import { useEffect, useId, useState } from "react";
import { motion } from "motion/react";
import { Globe, NotebookPen } from "lucide-react";
import { Button, Input } from "@/components/ui";
import type { Lx } from "./i18n";
import { hostOf } from "./paste";

export type PendingPaste =
  | { kind: "text"; text: string; title: string; sourceUrl: string | null }
  | { kind: "url"; url: string; title: string | null };

/**
 * The small question after a paste of text or a web address: an accidental paste must not create anything.
 * Text gets an editable title; Enter saves, Escape cancels. Key it by the paste so a new paste starts fresh.
 */
export function PasteConfirm({ L, pending, onSave, onCancel }: {
  L: Lx; pending: PendingPaste; onSave: (title: string) => void; onCancel: () => void;
}) {
  const { t } = L;
  const id = useId();
  const [title, setTitle] = useState(pending.kind === "text" ? pending.title : pending.title ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (pending.kind === "text" && !title.trim()) { setError(t("library.paste.titleNeeded")); document.getElementById(`${id}-title`)?.focus(); return; }
    onSave(title.trim());
  };

  const preview = pending.kind === "text" ? pending.text.slice(0, 400) : "";
  const from = pending.kind === "text" && pending.sourceUrl ? hostOf(pending.sourceUrl) : null;

  return (
    <motion.div role="dialog" aria-modal="false" aria-labelledby={`${id}-h`}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-4 bottom-20 z-50 rounded-lg bg-surface p-4 shadow-float sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[26rem]">
      <form onSubmit={submit}>
        <div className="flex items-start gap-3">
          <span aria-hidden className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg">
            {pending.kind === "url" ? <Globe className="size-4" /> : <NotebookPen className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-h`} className="text-[15px] font-semibold">
              {pending.kind === "url" ? t("library.paste.urlHeading") : t("library.paste.textHeading")}
            </h2>
            {pending.kind === "text" ? (
              <>
                <label htmlFor={`${id}-title`} className="mt-3 block text-sm font-medium">{t("library.paste.titleLabel")}</label>
                <Input autoFocus onFocus={(e) => e.currentTarget.select()} id={`${id}-title`} value={title} maxLength={200} className="mt-1 w-full"
                  aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined}
                  onChange={(e) => { setTitle(e.target.value); setError(null); }} />
                {error && <p id={`${id}-err`} className="mt-1 text-xs text-danger">{error}</p>}
                <p className="mt-3 line-clamp-3 whitespace-pre-line break-words text-sm text-muted">{preview}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted">
                  <span>{t("library.paste.chars", { count: pending.text.length })}</span>
                  {from && <span>{t("library.paste.from", { host: from })}</span>}
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 truncate text-sm text-accent" title={pending.url}>{pending.url}</p>
                <p className="mt-2 text-sm text-muted">{t("library.paste.urlHint")}</p>
              </>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>{t("library.paste.cancel")}</Button>
          <Button autoFocus={pending.kind === "url"} type="submit">{pending.kind === "url" ? t("library.paste.savePage") : t("library.paste.saveNote")}</Button>
        </div>
      </form>
    </motion.div>
  );
}
