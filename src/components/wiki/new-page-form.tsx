"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { VISIBILITIES, VISIBILITY_HINT, VISIBILITY_LABEL, type Visibility } from "@/lib/wiki/labels";

export function NewPageForm({ initialTitle = "" }: { initialTitle?: string }) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError("Give the page a title."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/wiki", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), visibility }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't create the page. Try again.");
      router.push(`/wiki/${encodeURIComponent(data.page.slug)}?edit=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the page. Try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-xl space-y-5" noValidate>
      <div>
        <label htmlFor={`${id}-title`} className="mb-1 block text-sm font-medium">Title</label>
        <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus required
          placeholder="e.g. Anna's school start, Summer holiday 2027, Car insurance"
          aria-invalid={!!error && !title.trim()} aria-describedby={error ? `${id}-error` : undefined} />
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Who can see this</legend>
        <div className="space-y-2">
          {VISIBILITIES.map((v) => (
            <label key={v} className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-tint">
              <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1 accent-[var(--accent)]" />
              <span>
                <span className="block text-sm font-medium">{VISIBILITY_LABEL[v]}</span>
                <span className="block text-xs text-muted">{VISIBILITY_HINT[v]}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">You can change this later.</p>
      </fieldset>
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create page"}</Button>
        <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
