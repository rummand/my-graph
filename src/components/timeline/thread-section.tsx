"use client";
/**
 * A conversation, message by message in the order it was written, each with its own source: the email in the
 * library it was read from, and what was proposed from it. Shared by the timeline drawer and the library.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { Paperclip } from "lucide-react";
import { Avatar, CitationChip, PersonChip } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ThreadInfo } from "@/lib/timeline/types";
import type { ThreadDetail, ThreadMessageDetail } from "@/lib/timeline/threads";
import { useWhen } from "./hooks";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; t: ThreadDetail };

export function ThreadSection({ thread }: { thread: ThreadInfo }) {
  const t = useT();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [retry, setRetry] = useState(0);
  const ids = thread.messages.map((m) => m.sourceId).join(",");

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ state: "loading" });
    fetch(`/api/timeline/thread?ids=${encodeURIComponent(ids)}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) { setLoad({ state: "error", message: body?.error ?? t("timeline.thread.loadFailed") }); return; }
        setLoad({ state: "ready", t: body as ThreadDetail });
      })
      .catch(() => { if (!ac.signal.aborted) setLoad({ state: "error", message: t("timeline.thread.offline") }); });
    return () => ac.abort();
  }, [ids, retry, t]);

  const personByEmail: Record<string, string> = Object.fromEntries(thread.participants.filter((p) => p.personId).map((p) => [p.email, p.personId!]));
  const others = thread.participants.filter((p) => !p.personId);

  return (
    <div className="space-y-5">
      {thread.participants.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">{t("timeline.thread.onIt")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {thread.participants.filter((p) => p.personId).map((p) => <PersonChip key={p.email} id={p.personId!} name={p.name} href={`/people/${p.personId}`} />)}
            {others.map((p) => (
              <span key={p.email} title={t("timeline.thread.notInGraph", { email: p.email })} className="inline-flex h-7 items-center rounded-full bg-surface-2 px-2.5 text-sm text-muted">{p.name}</span>
            ))}
          </div>
          {others.length > 0 && <p className="mt-1.5 text-xs text-muted">{t("timeline.thread.greyNames")}</p>}
        </section>
      )}

      <section aria-busy={load.state === "loading"}>
        <h3 className="mb-2.5 text-sm font-medium">{thread.messages.length === 1 ? t("timeline.thread.theMessage") : t("timeline.thread.messagesOldestFirst", { count: thread.messages.length })}</h3>
        {load.state === "loading" && <div className="h-24 animate-pulse rounded-lg bg-surface-2" />}
        {load.state === "error" && (
          <p className="text-sm text-muted">{load.message} <button type="button" className="font-medium text-accent hover:underline" onClick={() => setRetry((n) => n + 1)}>{t("timeline.tryAgain")}</button></p>
        )}
        {load.state === "ready" && <MessageList messages={load.t.messages} personByEmail={personByEmail} compact />}
      </section>
    </div>
  );
}

const emailIn = (s: string | null) => (s?.match(/<([^>]+)>/)?.[1] ?? s ?? "").toLowerCase().trim();
const nameIn = (s: string | null) => (s ?? "").replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "").trim() || s || "";

/** How a message's date was found, as a message key (timeline.thread.origin.*). */
const ORIGINS = new Set(["email", "model", "text", "parent", "exif", "pdf"]);

export function MessageList({ messages, personByEmail, compact = false }: { messages: ThreadMessageDetail[]; personByEmail: Record<string, string>; compact?: boolean }) {
  return (
    <ol className="space-y-4">
      {messages.map((m, i) => <Message key={m.sourceId} m={m} n={i + 1} personId={personByEmail[emailIn(m.from)] ?? null} compact={compact} />)}
    </ol>
  );
}

function Message({ m, n, personId, compact }: { m: ThreadMessageDetail; n: number; personId: string | null; compact: boolean }) {
  const t = useT();
  const w = useWhen();
  const [open, setOpen] = useState(!compact);
  const name = nameIn(m.from) || t("timeline.thread.someone");
  const long = m.body.length > 360;
  return (
    <li className="relative pl-9">
      <span className="absolute left-0 top-0.5"><Avatar id={personId ?? emailIn(m.from) ?? m.sourceId} name={name} size={26} /></span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{name}</span>
        {m.at && <time dateTime={m.at} className="text-sm tabular-nums text-muted">{w.fmt(m.at, "stamp")}</time>}
      </div>
      {(m.to || m.cc) && <p className="truncate text-xs text-muted" title={[m.to, m.cc].filter(Boolean).join(", ")}>{t("timeline.thread.to", { names: [m.to, m.cc].filter(Boolean).join(", ") })}</p>}
      {m.body && (
        <div className="mt-1.5">
          <p className={clsx("whitespace-pre-wrap break-words text-sm leading-relaxed", !open && long && "line-clamp-4")}>{m.body}</p>
          {long && <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-xs font-medium text-accent hover:underline">{open ? t("timeline.thread.showLess") : t("timeline.thread.readAll")}</button>}
        </div>
      )}
      {m.attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <Link href={`/library/${a.id}`} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs hover:bg-line"><Paperclip aria-hidden className="size-3" />{a.title}</Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <CitationChip n={n} title={t("timeline.thread.emailInLibrary")} href={`/library/${m.sourceId}`} />
        {m.dateFrom && m.dateFrom.origin !== "email" && <span className="text-xs text-muted">{t("timeline.thread.datedBy", { origin: ORIGINS.has(m.dateFrom.origin) ? t(`timeline.thread.origin.${m.dateFrom.origin}`) : m.dateFrom.origin })}</span>}
        {m.changeSetId && m.proposedTotal > 0 && (
          <Link href={`/changes/${m.changeSetId}`} className="text-xs font-medium text-warn hover:underline">{t("timeline.thread.proposed", { count: m.proposedTotal })}</Link>
        )}
      </div>
    </li>
  );
}
