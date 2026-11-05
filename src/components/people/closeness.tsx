"use client";
/** How close you are to someone, from what the graph holds (src/lib/people/interactions): the person page's pieces. */
import Link from "next/link";
import { useState } from "react";
import { Camera, CalendarDays, FileText, Mail, MessageCircle, Pencil, Phone, Pin, Users } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui";
import type { ClosenessView, InteractionKind, InteractionView } from "@/lib/people/interactions/pure";
import { monthsSince } from "@/lib/people/interactions/pure";
import { api, useFmt } from "./format";

export const KIND_ICON: Record<InteractionKind, typeof Mail> = {
  message: MessageCircle, email: Mail, call: Phone, meeting: Users, event: CalendarDays, photo: Camera, mention: FileText, edit: Pencil,
};

/** "Email 3 weeks ago" linked to where it came from, the band under it, and "Not in touch for 8 months" when it has been long. */
export function LastInTouch({ closeness, fallbackIso }: { closeness?: ClosenessView; fallbackIso: string | null }) {
  const f = useFmt();
  const { t } = f;
  const last = closeness?.lastInTouch;
  // A contact logged by hand (or an event) newer than anything derived wins.
  if (!last || (fallbackIso && fallbackIso > last.at)) {
    return (
      <>
        <span suppressHydrationWarning>{fallbackIso ? f.ago(fallbackIso) : t("people.when.never")}</span>
        {closeness && <span className="block text-[13px] font-normal text-muted">{t(`closeness.band.${closeness.band}`)}</span>}
      </>
    );
  }
  const text = t("closeness.lastLine", { kind: t(`closeness.kind.${last.kind}`), when: f.ago(last.at) });
  const months = monthsSince(last.at);
  return (
    <>
      {last.href ? <Link href={last.href} className="text-accent hover:underline" title={last.detail ?? undefined} suppressHydrationWarning>{text}</Link>
        : <span suppressHydrationWarning>{text}</span>}
      <span className="block text-[13px] font-normal text-muted" suppressHydrationWarning>
        {closeness ? t(`closeness.band.${closeness.band}`) : null}
        {closeness && closeness.band !== "close" && closeness.band !== "in_touch" && months >= 2 ? ` · ${t("closeness.quietFor", { count: months })}` : null}
      </span>
    </>
  );
}

/** A small time line of the latest interactions the viewer may read. */
export function InteractionTimeline({ items }: { items?: InteractionView[] }) {
  const f = useFmt();
  const { t } = f;
  const list = items ?? [];
  return (
    <section aria-labelledby="interactions-h" className="min-w-0">
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 id="interactions-h" className="text-lg font-semibold tracking-[-0.01em]">{t("closeness.timeline")}</h2>
      </div>
      {list.length === 0 ? (
        <p className="max-w-[60ch] text-sm text-muted">{t("closeness.timelineEmpty")}</p>
      ) : (
        <>
          <ol className="space-y-0.5">
            {list.map((i) => {
              const Icon = KIND_ICON[i.kind] ?? FileText;
              const body = (
                <>
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{t(`closeness.kind.${i.kind}`)}</span>
                    {i.detail && <span className="text-muted"> · {i.detail}</span>}
                  </span>
                  <time dateTime={i.at} title={f.full(i.at)} className="shrink-0 text-[13px] text-muted tabular-nums" suppressHydrationWarning>{f.ago(i.at)}</time>
                </>
              );
              return (
                <li key={i.id}>
                  {i.href
                    ? <Link href={i.href} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-2/70">{body}</Link>
                    : <div className="-mx-2 flex items-center gap-3 px-2 py-1.5 text-sm">{body}</div>}
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-muted">{t("closeness.timelineWhy")}</p>
        </>
      )}
    </section>
  );
}

/** Keep someone close: they never fade for you. Per person, per graph. */
export function PinButton({ personId, pinned: initial }: { personId: string; pinned: boolean }) {
  const { t } = useFmt();
  const [pinned, setPinned] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true); setError(null);
    try { await api(`/api/people/${personId}/pin`, { method: "PUT", json: { pinned: !pinned } }); setPinned(!pinned); }
    catch { setError(t("closeness.pinFailed")); } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-col items-end">
      <Button variant={pinned ? "secondary" : "ghost"} onClick={toggle} disabled={busy} aria-pressed={pinned} title={t(pinned ? "closeness.unpinHint" : "closeness.pinHint")}>
        <Pin className={clsx("size-4", pinned && "fill-current")} aria-hidden="true" />{t(pinned ? "closeness.pinned" : "closeness.pin")}
      </Button>
      {error && <span role="alert" className="mt-1 text-xs text-danger">{error}</span>}
    </span>
  );
}
