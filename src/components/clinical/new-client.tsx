"use client";
/** "Add client" / "Add patient": a name and the reason for referral; then straight to their record to register consent. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { Discipline } from "@/lib/clinical/pure";
import { call } from "./api";

const EASE = [0.22, 1, 0.36, 1] as const;

export function NewClient({ disciplines }: { disciplines: Discipline[] }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState<Discipline | null>(null);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {!open && (
        <div className="flex flex-wrap gap-2">
          {disciplines.map((d, i) => (
            <Button key={d} variant={i === 0 ? "primary" : "secondary"} onClick={() => setOpen(d)}>
              <Plus aria-hidden className="size-4" />{t(d === "psychology" ? "clinical.home.newClient" : "clinical.home.newPatient")}
            </Button>
          ))}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.form key="f" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
            className="w-full max-w-xl space-y-4 rounded-lg bg-surface p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true); setError(null);
              const r = await call<{ id: string }>("/api/clinical/clients", { body: { name, discipline: open, reason: reason || null } }, t("clinical.err.offline"));
              setBusy(false);
              if (r.error || !r.data) { setError(r.error ?? null); return; }
              router.push(`/clinical/clients/${r.data.id}`);
            }}>
            <h2 className="text-lg font-semibold">{t(open === "psychology" ? "clinical.newClient.titleClient" : "clinical.newClient.titlePatient")}</h2>
            <Field label={t("clinical.newClient.name")} hint={t("clinical.newClient.nameHint")} error={error}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("clinical.newClient.namePlaceholder")} required maxLength={120} autoFocus />
            </Field>
            <Field label={t("clinical.newClient.reason")}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("clinical.newClient.reasonPlaceholder")} rows={3} maxLength={2000} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name.trim()}>{t("clinical.newClient.create")}</Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(null)}>{t("clinical.newClient.cancel")}</Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
