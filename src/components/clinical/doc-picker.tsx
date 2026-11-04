"use client";
/** Pick a document from the practice's library, or upload one there (private and sensitive) and pick it. */
import { useEffect, useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { call } from "./api";

type Doc = { id: string; title: string; createdAt: string; status: string };

export function DocPicker({ value, onChange, label }: { value: string | null; onChange: (id: string | null) => void; label: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = async () => setDocs((await call<{ documents: Doc[] }>("/api/clinical/documents")).data?.documents ?? []);
  useEffect(() => { void load(); }, []);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Select aria-label={label} className="min-w-0 flex-1" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{t("clinical.consent.noDocument")}</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{d.title} ({fmt(d.createdAt)})</option>)}
        </Select>
        <input ref={input} type="file" className="sr-only" tabIndex={-1} accept=".pdf,image/*,.docx,.doc,.txt"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true); setError(null);
            const form = new FormData();
            form.append("file", f);
            form.append("visibility", "private");
            form.append("sensitive", "true");
            const r = await call<{ results?: { sourceId?: string }[]; sourceId?: string; sources?: { id: string }[] }>("/api/library", { form }, t("clinical.err.offline"));
            setBusy(false);
            if (r.error) { setError(r.error); return; }
            const id = r.data?.results?.[0]?.sourceId ?? r.data?.sourceId ?? r.data?.sources?.[0]?.id ?? null;
            await load();
            if (id) onChange(id);
            e.target.value = "";
          }} />
        <Button type="button" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          <Upload aria-hidden className="size-4" />{busy ? t("clinical.consent.uploading") : t("clinical.consent.uploadForm")}
        </Button>
      </div>
      {value && <a href={`/library/${value}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline"><FileText aria-hidden className="size-3.5" />{t("clinical.consent.open")}</a>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
