"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Pencil, X } from "lucide-react";
import { Button, Field, IconButton, Input, Select, Textarea } from "@/components/ui";
import { VISIBILITIES, visibilityLabel } from "@/components/provenance/labels";
import { useT } from "@/lib/i18n/client";

type Editable = { id: string; label: string; aliases: string[]; summary: string | null; visibility: string; sensitive: boolean };

/** Edit a node's name, other names, summary and who can see it, in a drawer from the right. Saved as a manual edit. */
export function NodeEditor({ node, family = false }: { node: Editable; family?: boolean }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(node.label);
  const [aliases, setAliases] = useState(node.aliases.join(", "));
  const [summary, setSummary] = useState(node.summary ?? "");
  const [visibility, setVisibility] = useState(node.visibility);
  const [sensitive, setSensitive] = useState(node.sensitive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function start() {
    setLabel(node.label); setAliases(node.aliases.join(", ")); setSummary(node.summary ?? "");
    setVisibility(node.visibility); setSensitive(node.sensitive); setError(null);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    document.getElementById(triggerId)?.focus();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) { setError(t("graph.editor.nameRequired")); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/nodes/${node.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label, summary, visibility, sensitive,
          aliases: aliases.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("graph.editor.couldNotSave"));
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("graph.editor.couldNotSave"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button id={triggerId} variant="secondary" onClick={start}><Pencil className="size-3.5" /> {t("graph.editor.edit")}</Button>
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="edit-node-h">
            <motion.div className="absolute inset-0 bg-fg/25" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }} onClick={() => !saving && close()} />
            <motion.form onSubmit={save} aria-label={t("graph.editor.editTitle", { name: node.label })}
              initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col bg-surface shadow-float">
              <div className="flex items-center justify-between px-6 pb-2 pt-5">
                <h2 id="edit-node-h" className="text-lg font-semibold">{t("graph.editor.editTitle", { name: node.label })}</h2>
                <IconButton type="button" label={t("graph.editor.close")} onClick={close} disabled={saving}><X className="size-4" /></IconButton>
              </div>
              <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
                <Field label={t("graph.editor.name")}>
                  <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
                </Field>
                <Field label={t("graph.editor.otherNames")} hint={t(family ? "graph.editor.otherNamesHintFamily" : "graph.editor.otherNamesHint")}>
                  <Input value={aliases} onChange={(e) => setAliases(e.target.value)} />
                </Field>
                <Field label={t("graph.editor.summary")}>
                  <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={6} maxLength={5000} />
                </Field>
                <Field label={t("graph.editor.whoCanSee")}>
                  <Select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    {VISIBILITIES.map((v) => <option key={v} value={v}>{visibilityLabel(v, family, t)}</option>)}
                  </Select>
                </Field>
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
                  <span>
                    <span className="block font-medium">{t("graph.editor.sensitive")}</span>
                    <span className="block text-muted">{t(family ? "graph.editor.sensitiveHintFamily" : "graph.editor.sensitiveHint")}</span>
                  </span>
                </label>
                <p aria-live="polite" className="text-sm text-danger empty:hidden">{error}</p>
              </div>
              <div className="flex gap-2 px-6 pb-6 pt-3">
                <Button type="submit" disabled={saving}>{saving ? t("graph.editor.saving") : t("graph.editor.save")}</Button>
                <Button type="button" variant="ghost" onClick={close} disabled={saving}>{t("graph.editor.cancel")}</Button>
              </div>
            </motion.form>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
