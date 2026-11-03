"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Pencil, X } from "lucide-react";
import { Button, Field, IconButton, Input, Select, Textarea } from "@/components/ui";
import { VISIBILITY_LABEL } from "@/components/provenance/labels";

type Editable = { id: string; label: string; aliases: string[]; summary: string | null; visibility: string; sensitive: boolean };

/** Edit a node's name, other names, summary and who can see it, in a drawer from the right. Saved as a manual edit. */
export function NodeEditor({ node }: { node: Editable }) {
  const router = useRouter();
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
    if (!label.trim()) { setError("A name is required."); return; }
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
      if (!res.ok) throw new Error(data.error ?? "Couldn't save. Please try again.");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button id={triggerId} variant="secondary" onClick={start}><Pencil className="size-3.5" /> Edit</Button>
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="edit-node-h">
            <motion.div className="absolute inset-0 bg-fg/25" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }} onClick={() => !saving && close()} />
            <motion.form onSubmit={save} aria-label={`Edit ${node.label}`}
              initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col bg-surface shadow-float">
              <div className="flex items-center justify-between px-6 pb-2 pt-5">
                <h2 id="edit-node-h" className="text-lg font-semibold">Edit {node.label}</h2>
                <IconButton type="button" label="Close" onClick={close} disabled={saving}><X className="size-4" /></IconButton>
              </div>
              <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
                <Field label="Name">
                  <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
                </Field>
                <Field label="Other names" hint="Separate with commas, e.g. Mormor, Inge">
                  <Input value={aliases} onChange={(e) => setAliases(e.target.value)} />
                </Field>
                <Field label="Summary">
                  <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={6} maxLength={5000} />
                </Field>
                <Field label="Who can see it">
                  <Select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    {Object.entries(VISIBILITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
                  <span>
                    <span className="block font-medium">Sensitive</span>
                    <span className="block text-muted">Health, money or legal. Hidden from children and only sent to models that run at home.</span>
                  </span>
                </label>
                <p aria-live="polite" className="text-sm text-danger empty:hidden">{error}</p>
              </div>
              <div className="flex gap-2 px-6 pb-6 pt-3">
                <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
                <Button type="button" variant="ghost" onClick={close} disabled={saving}>Cancel</Button>
              </div>
            </motion.form>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
