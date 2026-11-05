"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Folder, FolderPlus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { mimeCategory } from "@/lib/ingest/mime";
import type { Lx } from "./i18n";
import { TypeIcon } from "./source-meta";
import { pathLabel, reasonText, type SuggestionGroup } from "./folder-client";

const SHOWN = 4;
const HIDDEN_KEY = "library:suggestions:hidden";
const ease = [0.22, 1, 0.36, 1] as const;

/**
 * "Suggested folders": where the person's unfiled files could go, grouped by folder, each with its reason.
 * Nothing moves until they accept (all, a folder's worth, or one file); "Not here" drops a suggestion for good.
 */
export function FolderSuggestions({ L, groups, busy, onAccept, onDismiss }: {
  L: Lx; groups: SuggestionGroup[]; busy: boolean;
  onAccept: (ids: string[] | "all") => void; onDismiss: (ids: string[]) => void;
}) {
  const { t } = L;
  const [open, setOpenState] = useState(true);
  useEffect(() => { try { if (localStorage.getItem(HIDDEN_KEY) === "1") setOpenState(false); } catch { /* storage unavailable */ } }, []);
  const setOpen = (fn: (o: boolean) => boolean) => setOpenState((o) => {
    const n = fn(o);
    try { localStorage.setItem(HIDDEN_KEY, n ? "0" : "1"); } catch { /* ignore */ }
    return n;
  });
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  if (!total) return null;
  return (
    <section aria-labelledby="folder-suggestions-h" className="rounded-lg bg-surface px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 id="folder-suggestions-h" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.01em]">
            <span aria-hidden className="size-2 rounded-full bg-warn" />{t("library.folders.suggest.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{t("library.folders.suggest.lead", { count: total })}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" onClick={() => onAccept("all")} disabled={busy}>{t("library.folders.suggest.acceptAll", { count: total })}</Button>
          <Button type="button" size="sm" variant="ghost" aria-expanded={open} aria-controls="folder-suggestions-list" onClick={() => setOpen((o) => !o)}>
            <ChevronDown aria-hidden className={`size-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
            {open ? t("library.folders.suggest.hide") : t("library.folders.suggest.show")}
          </Button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id="folder-suggestions-list" key="list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <ul className="mt-4 space-y-5">
              {groups.map((g) => <Group key={g.path.join("/")} L={L} g={g} busy={busy} onAccept={onAccept} onDismiss={onDismiss} />)}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function Group({ L, g, busy, onAccept, onDismiss }: { L: Lx; g: SuggestionGroup; busy: boolean; onAccept: (ids: string[]) => void; onDismiss: (ids: string[]) => void }) {
  const { t } = L;
  const [all, setAll] = useState(false);
  const shown = all ? g.files : g.files.slice(0, SHOWN);
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        {g.exists ? <Folder aria-hidden className="size-4 shrink-0 text-muted" /> : <FolderPlus aria-hidden className="size-4 shrink-0 text-muted" />}
        <span className="min-w-0 font-medium">{pathLabel(g.path)}</span>
        {!g.exists && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t("library.folders.suggest.newFolder")}</span>}
        <span className="text-sm tabular-nums text-muted">{t("library.count.files", { count: g.files.length })}</span>
        {g.files.length > 1 && (
          <Button type="button" size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={() => onAccept(g.files.map((f) => f.id))}>
            {t("library.folders.suggest.acceptGroup", { count: g.files.length })}
          </Button>
        )}
      </div>
      <ul className="mt-1.5">
        <AnimatePresence initial={false}>
          {shown.map((f) => (
            <motion.li key={f.id} layout="position" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease }}
              className="flex items-center gap-3 border-b border-line py-2 last:border-0">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                <TypeIcon category={mimeCategory(f.mime)} mime={f.mime} className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/library/${f.id}`} className="block truncate text-sm font-medium hover:underline" title={f.title}>{f.title}</Link>
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                  {f.by === "model" && <Sparkles aria-label={t("library.folders.suggest.byModel")} className="size-3 shrink-0 text-inferred" />}
                  <span className="truncate" title={reasonText(L, f)}>{reasonText(L, f)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss([f.id])} aria-label={t("library.folders.suggest.dismissLabel", { name: f.title })}>
                  {t("library.folders.suggest.dismiss")}
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onAccept([f.id])} aria-label={t("library.folders.suggest.acceptLabel", { name: f.title, folder: pathLabel(g.path) })}>
                  {t("library.folders.suggest.accept")}
                </Button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {g.files.length > SHOWN && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 text-sm text-muted hover:text-fg hover:underline">
          {all ? t("library.folders.suggest.fewer") : t("library.folders.suggest.more", { count: g.files.length - SHOWN })}
        </button>
      )}
    </li>
  );
}
