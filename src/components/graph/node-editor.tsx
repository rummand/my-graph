"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea } from "@/components/ui";
import { VISIBILITY_LABEL } from "@/components/provenance/labels";

type Editable = { id: string; label: string; aliases: string[]; summary: string | null; visibility: string; sensitive: boolean };

/** Inline editor for a node's name, other names, summary and who can see it. Saved as a manual edit. */
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

  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Edit</Button>;

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
    <form onSubmit={save} className="w-full space-y-3 rounded-lg border border-line bg-surface p-4" aria-label="Edit this item">
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Name</span>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Other names</span>
        <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Separate with commas, e.g. Mormor, Inge" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Summary</span>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={5000} />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Who can see it</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
            {Object.entries(VISIBILITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          Sensitive (health, money, legal) — hidden from children, kept on local models
        </label>
      </div>
      <p aria-live="polite" className="text-sm text-danger empty:hidden">{error}</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
}
