"use client";
/** "New corpus": the form in a panel; on create, straight to the corpus page to add its documents. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { CorpusForm, corpusBodyOf, EMPTY_CORPUS } from "./corpus-form";

const EASE = [0.22, 1, 0.36, 1] as const;

export function NewCorpus({ startOpen = false, label }: { startOpen?: boolean; label?: string }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  return (
    <div>
      {!open && <Button variant="secondary" onClick={() => setOpen(true)}><Plus aria-hidden className="size-4" />{label ?? t("corpus.new")}</Button>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="form" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
            className="rounded-lg bg-surface p-5 text-left">
            <h2 className="mb-1 text-lg font-semibold">{t("corpus.new")}</h2>
            <p className="mb-4 text-sm text-muted">{t("corpus.kindHelp")}</p>
            <CorpusForm initial={EMPTY_CORPUS} submitLabel={t("corpus.form.create")} onCancel={() => setOpen(false)}
              onSubmit={async (v) => {
                try {
                  const res = await fetch("/api/corpora", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpusBodyOf(v)) });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) return data.error ?? t("compliance.errors.failed");
                  router.push(`/rules/${data.corpus.id}`);
                  return null;
                } catch {
                  return t("compliance.errors.offline");
                }
              }} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
