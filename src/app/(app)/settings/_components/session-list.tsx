"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Laptop, Smartphone, Tablet } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import type { SessionView } from "@/lib/auth/settings-data";
import { ErrorNote, Notice } from "@/app/login/notes";
import { useT } from "@/lib/i18n/client";
import { useWhen } from "./use-when";
import { PanelFooter } from "./section";

function DeviceIcon({ device }: { device: string }) {
  const d = device.toLowerCase();
  const Icon = /ipad|tablet/.test(d) ? Tablet : /iphone|android|phone|mobile/.test(d) ? Smartphone : Laptop;
  return <Icon size={16} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />;
}

/** Signed-in devices. `inset` drops the panel padding when the list sits inside another panel. */
export function SessionList({ sessions, allowSignOutOthers = true, inset }: { sessions: SessionView[]; allowSignOutOthers?: boolean; inset?: boolean }) {
  const router = useRouter();
  const t = useT();
  const w = useWhen();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const others = sessions.filter((s) => !s.current).length;
  const sorted = [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const pad = inset ? "" : "px-5 py-1";
  const LIMIT = 6;
  const visible = showAll ? sorted : sorted.slice(0, LIMIT);

  async function run(key: string, fn: () => Promise<{ signedOutHere?: boolean; signedOut?: number }>) {
    setBusy(key); setError(null); setNotice(null);
    try {
      const r = await fn();
      if (r.signedOutHere) { router.replace("/login?reason=signed_out"); return; }
      setNotice(typeof r.signedOut === "number" ? t("settings.sessions.signedOutN", { count: r.signedOut }) : t("settings.sessions.signedOut"));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!sessions.length) return <p className={`${inset ? "" : "p-5"} text-sm text-muted`}>{t("settings.sessions.none")}</p>;

  return (
    <div>
      <ul className={`divide-y divide-line ${pad}`}>
        <AnimatePresence initial={false}>
          {visible.map((s) => (
            <motion.li key={s.id} layout exit={{ opacity: 0, height: 0 }} className="flex min-h-14 items-center gap-3 py-2.5">
              <DeviceIcon device={s.device} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{s.device}</span>
                  {s.current && <Badge tone="accent">{t("settings.sessions.thisDevice")}</Badge>}
                  {!s.approved && <Badge tone="warn">{t("settings.sessions.waiting")}</Badge>}
                </p>
                <p className="text-sm text-muted">
                  {s.current ? t("settings.sessions.signedInWhen", { when: w.when(s.createdAt) }) : t("settings.sessions.lastUsed", { ago: w.ago(s.lastSeenAt), when: w.when(s.createdAt) })}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => run(s.id, () => api(`/api/auth/sessions/${s.id}`, { method: "DELETE" }))}
                  aria-label={t("settings.sessions.signOutDevice", { device: s.device })}>
                  {busy === s.id ? t("settings.sessions.signingOut") : t("settings.sessions.signOut")}
                </Button>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {sorted.length > LIMIT && (
        <div className={inset ? "pt-1" : "px-5"}>
          <button type="button" onClick={() => setShowAll(!showAll)} className="flex h-10 w-full items-center text-sm font-medium text-accent hover:underline underline-offset-2">
            {showAll ? t("settings.sessions.showFewer") : t("settings.sessions.showAll", { count: sorted.length })}
          </button>
        </div>
      )}
      {(error || notice || (allowSignOutOthers && others > 0)) && (
        <div className={inset ? "" : "px-5 pb-5"}>
          <ErrorNote message={error} className="mt-4" />
          <PanelFooter className="mt-3" status={<Notice message={notice} />}>
            {allowSignOutOthers && others > 0 && (
              <Button variant="secondary" disabled={busy !== null} onClick={() => run("others", () => api("/api/auth/sessions", { method: "DELETE" }))}>
                {busy === "others" ? t("settings.sessions.signingOut") : t("settings.sessions.signOutOthers", { count: others })}
              </Button>
            )}
          </PanelFooter>
        </div>
      )}
    </div>
  );
}

