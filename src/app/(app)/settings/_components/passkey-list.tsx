"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Fingerprint, KeyRound, Pencil, Trash2 } from "lucide-react";
import { Button, IconButton, Input } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { addPasskey, guessDeviceName, PasskeyError, passkeysSupported } from "@/lib/auth/client/passkeys";
import { ErrorNote, Notice } from "@/app/login/notes";
import { useT } from "@/lib/i18n/client";
import { useWhen } from "./use-when";
import { PanelFooter } from "./section";

type Pk = { id: string; name: string; createdAt: string };

export function PasskeyList({ passkeys }: { passkeys: Pk[] }) {
  const router = useRouter();
  const t = useT();
  const w = useWhen();
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => setSupported(passkeysSupported()), []);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setError(null); setNotice(null);
    try {
      await fn();
      setNotice(ok);
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof PasskeyError ? t(`auth.login.passkeyErrors.${e.code}`) : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {passkeys.length === 0 ? (
        <div className="flex items-start gap-3 px-5 pt-5">
          <Fingerprint size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div>
            <p className="font-medium">{t("settings.passkeys.none")}</p>
            <p className="mt-0.5 text-sm text-muted">{t("settings.passkeys.noneHint")}</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-line px-5">
          <AnimatePresence initial={false}>
            {passkeys.map((p) => (
              <motion.li key={p.id} layout exit={{ opacity: 0, height: 0 }} className="flex min-h-14 items-center gap-3 py-2.5">
                <KeyRound size={16} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
                {editing === p.id ? (
                  <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); run(p.id, () => api(`/api/auth/passkeys/${p.id}`, { method: "PATCH", json: { name: draft } }), t("settings.passkeys.renamed")); }}>
                    <label htmlFor={`pk-${p.id}`} className="sr-only">{t("settings.passkeys.name")}</label>
                    <Input id={`pk-${p.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} className="min-w-0 flex-1 basis-40" autoFocus
                      onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
                    <Button type="submit" size="sm" disabled={busy !== null || !draft.trim()}>{t("common.save")}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.name}</p>
                      <p className="text-sm text-muted">{t("settings.passkeys.added", { date: w.date(p.createdAt) })}</p>
                    </div>
                    <IconButton label={t("settings.passkeys.rename", { name: p.name })} onClick={() => { setEditing(p.id); setDraft(p.name); }}>
                      <Pencil size={15} aria-hidden />
                    </IconButton>
                    <IconButton label={t("settings.passkeys.remove", { name: p.name })} disabled={busy !== null} className="hover:text-danger"
                      onClick={() => { if (confirm(t("settings.passkeys.confirmRemove", { name: p.name }))) run(p.id, () => api(`/api/auth/passkeys/${p.id}`, { method: "DELETE" }), t("settings.passkeys.removed")); }}>
                      <Trash2 size={15} aria-hidden />
                    </IconButton>
                  </>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <div className="px-5 pb-5">
        <ErrorNote message={error} className="mt-4" />
        <PanelFooter className={passkeys.length ? "mt-3" : undefined} status={supported
          ? <Notice message={notice} />
          : <p className="text-sm text-muted">{t("settings.passkeys.unsupported")}</p>}>
          {supported && (
            <Button variant={passkeys.length ? "secondary" : "primary"} disabled={busy !== null}
              onClick={() => run("add", () => addPasskey(guessDeviceName()), t("settings.passkeys.addDone"))}>
              <Fingerprint size={16} aria-hidden />{busy === "add" ? t("settings.passkeys.addBusy") : t("settings.passkeys.add")}
            </Button>
          )}
        </PanelFooter>
      </div>
    </div>
  );
}
