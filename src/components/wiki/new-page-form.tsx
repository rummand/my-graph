"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Users } from "lucide-react";
import { Button } from "@/components/ui";
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
    <form onSubmit={submit} noValidate className="rounded-lg bg-surface px-5 pb-8 pt-8 sm:px-12 sm:pt-12 lg:px-16">
      <label htmlFor={`${id}-title`} className="sr-only">Title</label>
      <input id={`${id}-title`} value={title} onChange={(e) => { setTitle(e.target.value); if (error) setError(null); }} maxLength={200} autoFocus required
        placeholder="Untitled page" autoComplete="off"
        aria-invalid={!!error && !title.trim()} aria-describedby={error ? `${id}-error` : `${id}-title-hint`}
        className="block w-full max-w-[68ch] bg-transparent p-0 text-[28px]/[1.2] font-semibold tracking-[-0.02em] text-fg caret-accent outline-none placeholder:text-muted/60" style={{ outline: "none" }} />
      <p id={`${id}-title-hint`} className="mt-3 text-sm text-muted">For example: Emma&apos;s school start, Summer holiday 2027, Car insurance.</p>

      <fieldset className="mt-10">
        <legend className="mb-3 font-semibold">Who can see this</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {VISIBILITIES.map((v) => {
            const Icon = v === "private" ? Lock : Users;
            return (
              <label key={v} className="relative flex cursor-pointer flex-col gap-1 rounded-lg bg-surface-2/70 p-3.5 transition-colors hover:bg-surface-2 has-[:checked]:bg-accent-tint has-[:checked]:ring-2 has-[:checked]:ring-inset has-[:checked]:ring-accent has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
                <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="sr-only" />
                <span className="flex items-center gap-2 text-sm font-medium"><Icon aria-hidden className="size-4 text-muted" />{VISIBILITY_LABEL[v]}</span>
                <span className="text-sm text-muted">{VISIBILITY_HINT[v]}</span>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-sm text-muted">You can change this later.</p>
      </fieldset>

      {error && <p id={`${id}-error`} role="alert" className="mt-6 text-sm text-danger">{error}</p>}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create and start writing"}</Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
