"use client";
/**
 * "Add from a link": one field. Paste an address and press Enter; the rule set is created at once and its page opens
 * while the pages are fetched and read in the background.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, LoaderCircle } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

export function AddFromLink({ initial = "" }: { initial?: string }) {
  const t = useT();
  const router = useRouter();
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (raw: string) => {
    const u = raw.trim();
    if (u.length < 4 || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/corpora/from-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: u }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? t("compliance.errors.failed")); setBusy(false); return; }
      router.push(`/rules/${data.id}`);
    } catch {
      setError(t("compliance.errors.offline"));
      setBusy(false);
    }
  };
  return (
    <form className="rounded-lg bg-surface p-4" onSubmit={(e) => { e.preventDefault(); void go(url); }}>
      <label htmlFor="rules-link" className="mb-2 block font-medium">{t("corpus.link.label")}</label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Link2 aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input id="rules-link" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} disabled={busy} className="pl-9"
            placeholder={t("corpus.link.placeholder")} onChange={(e) => setUrl(e.target.value)}
            onPaste={(e) => {
              // Pasting is enough: no need to press anything else.
              const pasted = e.clipboardData.getData("text").trim();
              if (/^https?:\/\/\S+$/i.test(pasted) && !url.trim()) { e.preventDefault(); setUrl(pasted); void go(pasted); }
            }} />
        </div>
        <Button type="submit" disabled={busy || url.trim().length < 4}>
          {busy ? <><LoaderCircle aria-hidden className="size-4 animate-spin" />{t("corpus.link.reading")}</> : t("corpus.link.go")}
        </Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : <p className="mt-2 text-sm text-muted">{t("corpus.link.hint")}</p>}
    </form>
  );
}
