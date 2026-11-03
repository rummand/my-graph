"use client";
import { useCallback, useId, useRef, useState } from "react";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, CloudUpload, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui";
import { ACCEPT_ATTR, ACCEPTED_DESCRIPTION, MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";
import { formatBytes, type Visibility } from "./source-meta";
import { SensitiveToggle, VisibilitySelect } from "./visibility-select";

type Item = {
  key: string; name: string; size: number; progress: number;
  state: "uploading" | "done" | "duplicate" | "error"; error?: string; sourceId?: string;
};

type UploadResponse = { results?: { name: string; sourceId?: string; duplicate?: boolean; error?: string }[]; error?: string };

function uploadOne(file: File, visibility: Visibility, sensitive: boolean, onProgress: (p: number) => void): Promise<UploadResponse & { status: number }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", file);
    fd.append("visibility", visibility);
    fd.append("sensitive", String(sensitive));
    xhr.open("POST", "/api/library");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => resolve({ status: xhr.status, ...((xhr.response ?? {}) as UploadResponse) });
    xhr.onerror = () => resolve({ status: 0, error: "The connection dropped. Check your network and try again." });
    xhr.send(fd);
  });
}

export function UploadZone({ onUploaded }: { onUploaded?: () => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [sensitive, setSensitive] = useState(false);

  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const start = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const batch: { item: Item; file: File }[] = files.map((file) => ({
      file,
      item: { key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, name: file.name, size: file.size, progress: 0, state: "uploading" },
    }));
    for (const b of batch) {
      if (b.file.size > MAX_UPLOAD_BYTES) Object.assign(b.item, { state: "error", error: `${formatBytes(b.file.size)} is over the 50 MB limit.` });
      else if (b.file.size === 0) Object.assign(b.item, { state: "error", error: "The file is empty." });
    }
    setItems((xs) => [...batch.map((b) => b.item), ...xs]);
    // Two at a time keeps progress meaningful and the server calm.
    const queue = batch.filter((b) => b.item.state === "uploading");
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const { item, file } = b;
        const r = await uploadOne(file, visibility, sensitive, (p) => patch(item.key, { progress: p }));
        const res = r.results?.[0];
        if (res && !res.error) patch(item.key, { state: res.duplicate ? "duplicate" : "done", progress: 1, sourceId: res.sourceId });
        else patch(item.key, { state: "error", error: res?.error ?? r.error ?? (r.status === 401 ? "You've been signed out. Sign in and try again." : "Upload failed. Please try again.") });
        onUploaded?.();
      }
    };
    await Promise.all([worker(), worker()]);
  }, [visibility, sensitive, onUploaded]);

  const busy = items.some((i) => i.state === "uploading");

  return (
    <section aria-labelledby={`${inputId}-h`} className="rounded-lg border border-line bg-surface p-4">
      <h2 id={`${inputId}-h`} className="sr-only">Add files</h2>
      <div
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void start(Array.from(e.dataTransfer.files)); }}
        className={clsx("flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition",
          dragging ? "border-accent bg-accent-tint" : "border-line")}
      >
        <CloudUpload aria-hidden className="size-8 text-muted" />
        <p className="font-medium">Drop files here</p>
        <p className="max-w-md text-sm text-muted">{ACCEPTED_DESCRIPTION}. Up to 50 MB each. Originals are kept unchanged.</p>
        <input ref={inputRef} id={inputId} type="file" multiple accept={ACCEPT_ATTR} className="sr-only"
          onChange={(e) => { void start(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()} className="mt-1">Choose files</Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <VisibilitySelect value={visibility} onChange={setVisibility} label="Who can see new uploads" />
        <SensitiveToggle checked={sensitive} onChange={setSensitive} />
      </div>

      {items.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium" aria-live="polite">{busy ? "Uploading…" : "Uploads"}</p>
            {!busy && <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => setItems([])}>Clear list</Button>}
          </div>
          <ul className="space-y-2">
            {items.map((i) => (
              <li key={i.key} className="rounded-md border border-line px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  {i.state === "uploading" && <LoaderCircle aria-hidden className="size-4 shrink-0 text-muted motion-safe:animate-spin" />}
                  {(i.state === "done" || i.state === "duplicate") && <CheckCircle2 aria-hidden className="size-4 shrink-0 text-accent" />}
                  {i.state === "error" && <AlertTriangle aria-hidden className="size-4 shrink-0 text-danger" />}
                  <span className="min-w-0 flex-1 truncate" title={i.name}>
                    {i.sourceId ? <a className="hover:underline" href={`/library/${i.sourceId}`}>{i.name}</a> : i.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{formatBytes(i.size)}</span>
                  {i.state !== "uploading" && (
                    <button type="button" aria-label={`Remove ${i.name} from this list`} className="rounded p-0.5 text-muted hover:text-fg"
                      onClick={() => setItems((xs) => xs.filter((x) => x.key !== i.key))}>
                      <X aria-hidden className="size-4" />
                    </button>
                  )}
                </div>
                {i.state === "uploading" && (
                  <progress className="mt-2 h-1.5 w-full overflow-hidden rounded-full accent-[var(--accent)]" max={1} value={i.progress} aria-label={`Uploading ${i.name}`} />
                )}
                {i.state === "duplicate" && <p className="mt-1 text-xs text-muted">This exact file is already in your library. The name links to it.</p>}
                {i.state === "done" && <p className="mt-1 text-xs text-muted">Uploaded. Reading it now — this can take a minute.</p>}
                {i.state === "error" && <p className="mt-1 text-xs text-danger">{i.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
