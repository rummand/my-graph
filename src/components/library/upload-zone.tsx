"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { format } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpFromLine, Check, LoaderCircle, X } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import type { SourceSummary } from "@/lib/ingest/library";
import { ACCEPT_ATTR, MAX_UPLOAD_BYTES, mimeCategory } from "@/lib/ingest/mime";
import { extractionNote, formatBytes, isStuck, TypeIcon, type Visibility } from "./source-meta";
import { SensitiveToggle, VisibilitySelect } from "./visibility-select";

type Item = {
  key: string; name: string; size: number; mime: string; progress: number; preview: string | null;
  state: "queued" | "uploading" | "done" | "duplicate" | "error"; error?: string; sourceId?: string;
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

/** Pasted screenshots arrive as "image.png"; give them a name a person can find again. */
function namePasted(f: File, i: number): File {
  if (f.name && f.name !== "image.png" && f.name !== "image.jpeg") return f;
  const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  return new File([f], `Pasted image ${format(new Date(), "d MMM HH.mm")}${i ? ` (${i + 1})` : ""}.${ext}`, { type: f.type });
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Where files come in: a large drop area (the whole window accepts a drop, and ⌘V pastes files),
 * the default sharing for new files, and one row per file that follows it from upload to "read".
 */
export function UploadZone({ onUploaded, statusOf, onWatching, prominent = false }: {
  onUploaded?: () => void;
  /** Live state of an uploaded file, from the library list. */
  statusOf?: (sourceId: string) => SourceSummary | undefined;
  /** Tells the list to keep polling while an upload is still being read. */
  onWatching?: (watching: boolean) => void;
  /** Bigger, for an empty library. */
  prominent?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [sensitive, setSensitive] = useState(false);
  const depth = useRef(0);

  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const start = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const batch: { item: Item; file: File }[] = files.map((file) => ({
      file,
      item: {
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, name: file.name, size: file.size, mime: file.type,
        progress: 0, state: "queued",
        preview: file.type.startsWith("image/") && file.type !== "image/heic" && file.size < 25 * 1024 * 1024 ? URL.createObjectURL(file) : null,
      },
    }));
    for (const b of batch) {
      if (b.file.size > MAX_UPLOAD_BYTES) Object.assign(b.item, { state: "error", error: `This file is ${formatBytes(b.file.size)}. The limit is 50 MB.` });
      else if (b.file.size === 0) Object.assign(b.item, { state: "error", error: "The file is empty." });
    }
    setItems((xs) => [...batch.map((b) => b.item), ...xs]);
    // Two at a time keeps progress meaningful and the server calm.
    const queue = batch.filter((b) => b.item.state === "queued");
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const { item, file } = b;
        patch(item.key, { state: "uploading" });
        const r = await uploadOne(file, visibility, sensitive, (p) => patch(item.key, { progress: p }));
        const res = r.results?.[0];
        if (res && !res.error) patch(item.key, { state: res.duplicate ? "duplicate" : "done", progress: 1, sourceId: res.sourceId });
        else patch(item.key, { state: "error", error: res?.error ?? r.error ?? (r.status === 401 ? "You've been signed out. Sign in and try again." : "Upload failed. Please try again.") });
        onUploaded?.();
      }
    };
    await Promise.all([worker(), worker()]);
  }, [visibility, sensitive, onUploaded]);

  // The whole window is a drop target while files are dragged over it.
  useEffect(() => {
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setDragging(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void start(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [start]);

  // Paste files or screenshots anywhere on the page (text pastes into fields are left alone).
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void start(files.map(namePasted));
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [start]);

  // Free image previews when rows go away.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(items.map((i) => i.preview).filter((p): p is string => !!p));
    for (const p of previews.current) if (!now.has(p)) URL.revokeObjectURL(p);
    previews.current = now;
  }, [items]);
  useEffect(() => () => { for (const p of previews.current) URL.revokeObjectURL(p); }, []);

  const live = (i: Item) => (i.sourceId && i.state === "done" ? statusOf?.(i.sourceId) : undefined);
  const watching = items.some((i) => {
    const s = live(i);
    return !!s && (s.status === "pending" || s.status === "processing") && !isStuck(s.status, s.startedAt, s.createdAt);
  });
  useEffect(() => { onWatching?.(watching); }, [watching, onWatching]);

  const uploading = items.filter((i) => i.state === "uploading" || i.state === "queued").length;
  const finished = items.length > 0 && uploading === 0;

  return (
    <section aria-labelledby={`${inputId}-h`} className="relative">
      <div className={clsx("rounded-lg bg-surface transition-[box-shadow,background-color] duration-150",
        dragging ? "bg-accent-tint ring-2 ring-accent" : "ring-0")}>
        <div className={clsx("grid gap-x-10 gap-y-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto]", prominent && "lg:py-10")}>
          <div className="flex min-w-0 gap-4">
            <span aria-hidden className={clsx("hidden size-11 shrink-0 items-center justify-center rounded-full transition-colors sm:inline-flex",
              dragging ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg")}>
              <ArrowUpFromLine className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 id={`${inputId}-h`} className="text-lg font-semibold tracking-[-0.01em]">
                {dragging ? "Let go to add them to the library" : prominent ? "Add the first letter, photo or recording" : <><span className="sm:hidden">Add letters, photos and recordings</span><span className="hidden sm:inline">Drop files here, or paste them</span></>}
              </h2>
              <p className="mt-1 hidden max-w-[56ch] text-sm text-muted sm:block">
                School letters, appointment cards, scans, photos, voice memos and emails, up to 50 MB each.
                The original is kept exactly as it is, then read for the people and dates in it.
              </p>
              <p className="mt-1 text-sm text-muted sm:hidden">Up to 50 MB each. The original is kept as it is.</p>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <input ref={inputRef} id={inputId} type="file" multiple accept={ACCEPT_ATTR} className="sr-only" tabIndex={-1}
                  onChange={(e) => { void start(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                <Button type="button" onClick={() => inputRef.current?.click()}>Choose files</Button>
                <span className="hidden text-sm text-muted sm:inline">or paste with <Kbd>⌘</Kbd> <Kbd>V</Kbd></span>
              </div>
            </div>
          </div>
          <div className="min-w-0 space-y-4 lg:w-[340px]">
            <VisibilitySelect value={visibility} onChange={setVisibility} label="New files can be seen by" />
            <SensitiveToggle checked={sensitive} onChange={setSensitive} compact />
          </div>
        </div>

        <AnimatePresence initial={false}>
          {items.length > 0 && (
            <motion.div key="queue" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="border-t border-line px-5 pb-3 pt-3 sm:px-6">
                <div className="flex items-center justify-between gap-3 py-1">
                  <p className="text-sm font-medium" aria-live="polite">
                    {uploading > 0 ? `Uploading ${uploading} ${uploading === 1 ? "file" : "files"}` : `${items.length} ${items.length === 1 ? "file" : "files"} added just now`}
                  </p>
                  {finished && <Button type="button" variant="ghost" size="sm" onClick={() => setItems([])}>Clear</Button>}
                </div>
                <ul>
                  <AnimatePresence initial={false}>
                    {items.map((i) => (
                      <motion.li key={i.key} layout="position" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                        <UploadRow item={i} live={live(i)} onRemove={() => setItems((xs) => xs.filter((x) => x.key !== i.key))} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Drop anywhere: a quiet layer over the page while files are dragged in. */}
      <AnimatePresence>
        {dragging && (
          <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="pointer-events-none fixed inset-0 z-40 flex items-end justify-center bg-bg/60 p-6 sm:items-center">
            <motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} exit={{ scale: 0.98 }}
              className="flex items-center gap-3 rounded-lg bg-fg px-5 py-4 text-bg shadow-float">
              <ArrowUpFromLine className="size-5" />
              <span className="font-medium">Drop to add to the library</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function UploadRow({ item: i, live, onRemove }: { item: Item; live?: SourceSummary; onRemove: () => void }) {
  const category = mimeCategory(i.mime);
  const stuck = live ? isStuck(live.status, live.startedAt, live.createdAt) : false;
  const href = i.sourceId ? `/library/${i.sourceId}` : undefined;

  let line: React.ReactNode;
  let tone: "muted" | "accent" | "danger" | "warn" = "muted";
  let spinning = false;
  let done = false;
  if (i.state === "queued") line = "Waiting to upload";
  else if (i.state === "uploading") { line = i.progress >= 1 ? "Saving the original" : `Uploading, ${Math.round(i.progress * 100)}%`; spinning = true; }
  else if (i.state === "error") { line = i.error; tone = "danger"; }
  else if (i.state === "duplicate") line = "Already in the library. The name opens the copy you have.";
  else if (!live) { line = "Uploaded. Reading starts in a moment."; spinning = true; }
  else if (stuck) { line = "This has been waiting a long time. Open it to read it again."; tone = "warn"; }
  else if (live.status === "pending") { line = "Uploaded, waiting its turn to be read"; spinning = true; }
  else if (live.status === "processing") { line = "Reading it for people, places and dates"; tone = "accent"; spinning = true; }
  else if (live.status === "failed") { line = live.error ?? "Reading this file failed. Open it to try again."; tone = "danger"; }
  else {
    const note = extractionNote(live.extraction);
    line = note ? "Saved, but not read for people yet. Open it for details." : "Read. Open it to see what was found.";
    tone = note ? "warn" : "muted";
    done = !note;
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="relative size-10 shrink-0 overflow-hidden rounded-md bg-surface-2 text-muted">
        {i.preview
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
          ? <img src={i.preview} alt="" className="size-full object-cover" />
          : <span className="flex size-full items-center justify-center"><TypeIcon category={category} mime={i.mime} className="size-5" /></span>}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={i.name}>
            {href ? <Link href={href} className="hover:underline">{i.name}</Link> : i.name}
          </p>
          <span className="shrink-0 text-xs tabular-nums text-muted">{formatBytes(i.size)}</span>
        </div>
        <p className={clsx("mt-0.5 flex items-center gap-1.5 text-xs",
          tone === "muted" && "text-muted", tone === "accent" && "text-accent", tone === "danger" && "text-danger", tone === "warn" && "text-warn")}>
          {spinning && <LoaderCircle aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />}
          {done && <Check aria-hidden className="size-3 shrink-0" />}
          <span className="min-w-0">{line}</span>
        </p>
        {(i.state === "uploading" || i.state === "queued") && (
          <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`Uploading ${i.name}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(i.progress * 100)}>
            <div className="h-full origin-left rounded-full bg-accent transition-transform duration-200 ease-out" style={{ transform: `scaleX(${i.progress})` }} />
          </div>
        )}
      </div>
      {i.state !== "uploading" && i.state !== "queued" ? (
        <button type="button" aria-label={`Remove ${i.name} from this list`} onClick={onRemove}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <X aria-hidden className="size-4" />
        </button>
      ) : <span className="size-8 shrink-0" />}
    </div>
  );
}
