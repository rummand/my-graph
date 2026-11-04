"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Button, buttonClass, EmptyState, Section } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";
import { api, ConnectorIcon, CountsLine, iconFor, StatusBadge, StatusDot, useStatusText, type Person } from "./bits";
import { ConnectForm } from "./connect-form";
import { DisconnectDialog } from "./disconnect-dialog";

const EASE = [0.22, 1, 0.36, 1] as const;

/** /connections: my connections in this graph with their status and actions, then the gallery to add one. */
export function ConnectionsApp({ initial, connectors, people, family, graphName }: {
  initial: ConnectionDTO[]; connectors: ConnectorInfo[]; people: Person[]; family: boolean; graphName: string;
}) {
  const t = useT();
  const [list, setList] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<ConnectionDTO | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const galleryRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const d = await api<{ connections: ConnectionDTO[] }>("/api/connections").catch(() => null);
    if (d) setList(d.connections);
  }, []);

  // While something is checking, look again every few seconds.
  const busy = list.some((c) => c.status === "running" || c.status === "new");
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => { void reload(); }, 3000);
    return () => clearInterval(id);
  }, [busy, reload]);

  const patch = (c: ConnectionDTO) => setList((l) => (l.some((x) => x.id === c.id) ? l.map((x) => (x.id === c.id ? c : x)) : [c, ...l]));

  return (
    <div className="space-y-10">
      {notice && <p role="status" className="rounded-md bg-surface px-3 py-2 text-sm">{notice}</p>}
      <Section title={t("connections.yoursTitle")}>
        {list.length === 0 ? (
          <EmptyState title={t("connections.noneTitle")}
            action={<Button onClick={() => galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("connections.addTitle")}</Button>}>
            {t("connections.none")}
          </EmptyState>
        ) : (
          <motion.ul layout className="divide-y divide-line rounded-lg bg-surface">
            <AnimatePresence initial={false}>
              {list.map((c) => (
                <motion.li key={c.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: EASE }}>
                  <ConnectionRow c={c} onChanged={patch} onDisconnect={() => setLeaving(c)} onError={setNotice} />
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </Section>

      <div ref={galleryRef} className="scroll-mt-6">
        <Section title={t("connections.addTitle")}>
          <p className="mb-4 max-w-[65ch] text-sm text-muted">{t("connections.addLead", { graph: graphName })}</p>
          <ul className="divide-y divide-line rounded-lg bg-surface">
            {connectors.map((info) => (
              <li key={info.id} className="px-4 py-4">
                <GalleryItem info={info} open={open === info.id} onToggle={() => setOpen(open === info.id ? null : info.id)}>
                  <ConnectForm info={info} people={people} family={family}
                    onCancel={() => setOpen(null)}
                    onDone={(c) => { patch(c); setOpen(null); setNotice(null); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
                </GalleryItem>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-[65ch] text-sm text-muted">{t("connections.rules")}</p>
        </Section>
      </div>

      <Section title={t("connections.byHandTitle")}>
        <p className="max-w-[65ch] text-muted">{t("connections.byHand")}</p>
        <Link href="/library" className={clsx(buttonClass("secondary", "sm"), "mt-3")}>{t("connections.toLibrary")}</Link>
      </Section>

      <DisconnectDialog connection={leaving} onClose={() => setLeaving(null)}
        onDone={(msg) => { setList((l) => l.filter((x) => x.id !== leaving?.id)); setLeaving(null); setNotice(msg); }} />
    </div>
  );
}

function ConnectionRow({ c, onChanged, onDisconnect, onError }: { c: ConnectionDTO; onChanged: (c: ConnectionDTO) => void; onDisconnect: () => void; onError: (m: string | null) => void }) {
  const t = useT();
  const statusText = useStatusText();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<ConnectionDTO | null>) => {
    setBusy(true); onError(null);
    try {
      const next = await fn();
      if (next) onChanged(next);
    } catch (e) {
      onError(e instanceof Error ? e.message : t("connections.errors.generic"));
    } finally {
      setBusy(false);
    }
  };
  const runNow = () => act(async () => {
    await api(`/api/connections/${c.id}/run`, { method: "POST" });
    return { ...c, status: "running" };
  });
  const setPaused = (paused: boolean) => act(async () => (await api<{ connection: ConnectionDTO }>(`/api/connections/${c.id}`, { method: "PATCH", json: { paused } })).connection);
  const host = typeof c.config.feedHost === "string" ? c.config.feedHost : null;

  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <ConnectorIcon icon={iconFor(c.connector)} className="mt-1" />
        <div className="min-w-0">
          <Link href={`/connections/${c.id}`} className="font-medium hover:underline">{c.label}</Link>
          {host && <span className="ml-2 text-sm text-muted">{t("connections.detail.from", { host })}</span>}
          <p className={clsx("mt-0.5 flex items-center gap-2 text-sm", c.status === "needs_you" ? "text-warn" : "text-muted")}>
            <StatusDot status={c.status} /><span>{statusText(c)}</span>
          </p>
          <CountsLine c={c} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-7 sm:pl-0">
        {c.status === "needs_you"
          ? <Link href={`/connections/${c.id}#settings`} className={buttonClass("primary", "sm")}>{t("connections.actions.fix")}</Link>
          : c.status !== "paused" && <Button size="sm" variant="secondary" disabled={busy || c.status === "running"} onClick={runNow}>{t("connections.actions.runNow")}</Button>}
        {c.status === "paused"
          ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPaused(false)}>{t("connections.actions.resume")}</Button>
          : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPaused(true)}>{t("connections.actions.pause")}</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDisconnect}>{t("connections.actions.disconnect")}</Button>
      </div>
    </div>
  );
}

function GalleryItem({ info, open, onToggle, children }: { info: ConnectorInfo; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const t = useT();
  const soon = info.status === "coming_soon";
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <ConnectorIcon icon={info.icon} className="mt-1" />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t(`connections.connectors.${info.id}.title`)}</span>
              <StatusBadge status={soon ? "coming_soon" : info.status} />
              {soon && <StatusBadge status="unofficial" />}
            </p>
            <p className="mt-0.5 max-w-[60ch] text-sm text-muted">{t(`connections.connectors.${info.id}.blurb`)}</p>
            <dl className="mt-2 grid max-w-[60ch] gap-1 text-sm">
              <div><dt className="inline font-medium">{t("connections.readsLabel")}: </dt><dd className="inline text-muted">{t(`connections.connectors.${info.id}.reads`)}</dd></div>
              <div><dt className="inline font-medium">{t("connections.neverLabel")}: </dt><dd className="inline text-muted">{t(`connections.connectors.${info.id}.never`)}</dd></div>
            </dl>
            {soon && <p className="mt-2 max-w-[65ch] text-sm text-muted">{t(`connections.connectors.${info.id}.soon`)}</p>}
          </div>
        </div>
        {!soon && !open && <Button size="sm" variant="secondary" className="ml-7 self-start sm:ml-0" onClick={onToggle} aria-expanded={open}>{t("connections.connect")}</Button>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="form" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <div className="pt-4 sm:pl-7">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
