"use client";
/**
 * Version history on a profile: one timeline of what changed — the graph's own history of this node and its facts
 * (who added, changed or removed what, from which proposal) and every saved version of the written notes. Any notes
 * version can be read and restored as a proposal; any moment can be restored as a proposal for the facts too.
 * Nothing changes until a person delivers the proposal.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FileText, GitCommitHorizontal, History, X } from "lucide-react";
import { clsx } from "clsx";
import { Button, IconButton } from "@/components/ui";
import { historyLine } from "@/components/history/pure";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { HistoryEvent } from "@/lib/changes";
import type { ProfileDoc } from "@/lib/profile/doc";
import type { DocVersion } from "@/lib/profile/types";
import { ProfileEditor } from "./profile-editor";

type Item =
  | { kind: "doc"; at: string; v: DocVersion }
  | { kind: "event"; at: string; e: HistoryEvent };

export function VersionHistory({ nodeId, name, canEdit, refreshKey, onChanged, className }: {
  nodeId: string; name: string; canEdit: boolean; refreshKey: number; onChanged: () => void; className?: string;
}) {
  const t = useT();
  const fmt = useFormatDate();
  const [items, setItems] = useState<Item[] | null>(null);
  const [limit, setLimit] = useState(8);
  const [viewing, setViewing] = useState<(DocVersion & { doc: ProfileDoc }) | null>(null);
  const [status, setStatus] = useState<{ text: string; href?: string; error?: boolean } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/profile/${nodeId}/versions`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (!data) { setItems([]); return; }
    const docs: Item[] = (data.versions as DocVersion[]).filter((v) => v.event === "saved" || v.event === "restored").map((v) => ({ kind: "doc", at: v.createdAt, v }));
    const events: Item[] = (data.events as HistoryEvent[]).filter((e) => e.subjectType !== "profile").map((e) => ({ kind: "event", at: String(e.at), e }));
    setItems([...docs, ...events].sort((a, b) => b.at.localeCompare(a.at)));
  }, [nodeId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const view = async (v: DocVersion) => {
    const res = await fetch(`/api/profile/${nodeId}/versions/${v.id}`).catch(() => null);
    if (res?.ok) setViewing(await res.json());
  };

  const restoreDoc = async (v: DocVersion) => {
    setStatus(null);
    const res = await fetch(`/api/profile/${nodeId}/versions/${v.id}/restore`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) { setStatus({ text: data.error ?? t("profile.history.failed"), error: true }); return; }
    setViewing(null);
    setStatus({ text: t("profile.history.docProposed", { version: v.version }) });
    onChanged();
  };

  const rewind = async (at: string) => {
    setStatus(null);
    // Just before that change: the profile as it was then.
    const before = new Date(new Date(at).getTime() - 1).toISOString();
    const res = await fetch(`/api/profile/${nodeId}/rewind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: before }) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) { setStatus({ text: data.error ?? t("profile.history.failed"), error: true }); return; }
    if (!data.changeSetId) { setStatus({ text: t("profile.history.nothingToRestore") }); return; }
    setStatus({ text: t("profile.history.factsProposed", { count: data.ops }), href: `/changes/${data.changeSetId}` });
    onChanged();
  };

  if (items === null) return null;
  const shown = items.slice(0, limit);
  return (
    <section aria-labelledby="profile-history-h" className={className}>
      <div className="mb-3 flex items-center gap-2">
        <History aria-hidden className="size-4 text-muted" />
        <h2 id="profile-history-h" className="text-lg font-semibold tracking-[-0.01em]">{t("profile.history.title")}</h2>
      </div>
      {status && (
        <p role="status" className={clsx("mb-3 text-sm", status.error ? "text-danger" : "")}>
          {status.text} {status.href && <Link href={status.href} className="text-accent hover:underline">{t("profile.history.openProposal")}</Link>}
        </p>
      )}
      {items.length === 0 ? <p className="text-sm text-muted">{t("profile.history.empty", { name })}</p> : (
        <ol className="relative space-y-4 border-l border-line pl-4">
          {shown.map((it) => (
            <li key={it.kind === "doc" ? it.v.id : it.e.id} className="relative text-sm">
              <span aria-hidden className="absolute -left-[21px] top-1 grid size-[9px] place-items-center rounded-full bg-bg ring-2 ring-line" />
              <time dateTime={it.at} className="block text-xs tabular-nums text-muted" suppressHydrationWarning>{fmt(it.at, "dateTime")}</time>
              {it.kind === "doc" ? (
                <div className="min-w-0">
                  <p className="flex items-start gap-1.5 break-words">
                    <FileText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
                    <span>{t(it.v.event === "restored" ? "profile.history.docRestored" : "profile.history.docSaved", { who: it.v.createdByName ?? t("history.actor.person"), version: it.v.version })}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-3">
                    <button type="button" className="text-accent hover:underline" onClick={() => view(it.v)}>{t("profile.history.view")}</button>
                    {canEdit && <button type="button" className="text-accent hover:underline" onClick={() => restoreDoc(it.v)}>{t("profile.history.restoreProposal")}</button>}
                  </div>
                </div>
              ) : (
                <EventLine e={it.e} nodeId={nodeId} canEdit={canEdit} onRewind={() => rewind(it.at)} />
              )}
            </li>
          ))}
        </ol>
      )}
      {items.length > limit && <button type="button" className="mt-3 text-sm text-accent hover:underline" onClick={() => setLimit((l) => l + 15)}>{t("profile.history.more", { count: items.length - limit })}</button>}

      <AnimatePresence>
        {viewing && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-fg/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
            <motion.div role="dialog" aria-modal="true" aria-labelledby="profile-version-h" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface shadow-float">
              <div className="flex items-start justify-between gap-3 p-5 pb-3">
                <div>
                  <h2 id="profile-version-h" className="text-lg font-semibold">{t("profile.history.versionTitle", { version: viewing.version })}</h2>
                  <p className="text-sm text-muted" suppressHydrationWarning>{t("profile.history.versionBy", { who: viewing.createdByName ?? t("history.actor.person"), when: fmt(viewing.createdAt, "date") })}</p>
                </div>
                <IconButton label={t("profile.history.close")} onClick={() => setViewing(null)}><X className="size-4" /></IconButton>
              </div>
              <div className="min-h-0 overflow-y-auto px-5 pb-4">
                <ProfileEditor key={viewing.id} nodeId={nodeId} name={name} initialDoc={viewing.doc} initialVersion={viewing.version} editable={false} highlights={false}
                  onFactCommand={() => {}} onImageCommand={() => {}} />
              </div>
              {canEdit && (
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
                  <p className="mr-auto text-xs text-muted">{t("profile.history.restoreHint")}</p>
                  <Button variant="secondary" onClick={() => setViewing(null)}>{t("profile.history.close")}</Button>
                  <Button onClick={() => restoreDoc(viewing)}>{t("profile.history.restoreProposal")}</Button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </section>
  );
}

function EventLine({ e, nodeId, canEdit, onRewind }: { e: HistoryEvent; nodeId: string; canEdit: boolean; onRewind: () => void }) {
  const t = useT();
  const line = historyLine(e, t);
  const about = e.subjectId !== nodeId && e.subjectName ? e.subjectName : null;
  return (
    <div className="min-w-0">
      <p className="flex items-start gap-1.5 break-words">
        <GitCommitHorizontal aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
        <span>{line.head}{about ? <span className="text-muted"> · {about}</span> : null}</span>
      </p>
      {line.detail && <p className="break-words pl-5 text-xs text-muted">{line.detail}</p>}
      <div className="mt-1 flex flex-wrap gap-x-3 pl-5">
        {e.changeSetId && <Link href={`/changes/${e.changeSetId}`} className="text-accent hover:underline">{t("history.showProposal")}</Link>}
        {canEdit && <button type="button" className="text-accent hover:underline" onClick={onRewind}>{t("profile.history.rewind")}</button>}
      </div>
    </div>
  );
}
