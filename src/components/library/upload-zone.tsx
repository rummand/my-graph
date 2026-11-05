"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpFromLine, Check, ClipboardPaste, Folder, Globe, LoaderCircle, X } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import type { SourceSummary } from "@/lib/ingest/library";
import { ACCEPT_ATTR, MAX_UPLOAD_BYTES, mimeCategory } from "@/lib/ingest/mime";
import { isStuck, stepText, TypeIcon } from "./source-meta";
import { extractionNote, formatBytes, type Lx, type Visibility } from "./i18n";
import { formatDate } from "@/lib/i18n/dates";
import { useLx } from "./use-lx";
import { SensitiveToggle, VisibilitySelect } from "./visibility-select";
import { PasteConfirm, type PendingPaste } from "./paste-confirm";
import { choosePaste, hostOf, isApplePlatform, isTextTarget, pastedFiles, titleFromText, type ClipboardSnapshot } from "./paste";

type Item = {
  key: string; name: string; size: number | null; mime: string; progress: number; preview: string | null;
  state: "queued" | "uploading" | "done" | "duplicate" | "error"; error?: string; sourceId?: string;
  /** A file, pasted text (a note) or a pasted web address (a saved page). */
  origin: "file" | "text" | "url";
  /** Web pages: the site. */
  host?: string | null;
  /** A page saved as a link only: why. */
  note?: string;
};

type PasteResponse = { sourceId?: string; duplicate?: boolean; title?: string; read?: boolean; webOff?: boolean; error?: string };

type UploadResponse = { results?: { name: string; sourceId?: string; duplicate?: boolean; error?: string }[]; error?: string };

function uploadOne(file: File, visibility: Visibility, sensitive: boolean, folderId: string | null, onProgress: (p: number) => void, dropped: string): Promise<UploadResponse & { status: number }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append("file", file);
    fd.append("visibility", visibility);
    fd.append("sensitive", String(sensitive));
    if (folderId) fd.append("folderId", folderId);
    xhr.open("POST", "/api/library");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => resolve({ status: xhr.status, ...((xhr.response ?? {}) as UploadResponse) });
    xhr.onerror = () => resolve({ status: 0, error: dropped });
    xhr.send(fd);
  });
}

/** Pasted screenshots arrive as "image.png"; give them a name a person can find again. */
function namePasted(L: Lx, f: File, i: number): File {
  if (f.name && f.name !== "image.png" && f.name !== "image.jpeg") return f;
  const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const now = new Date();
  const when = `${formatDate(now, "date", { locale: L.locale, timeZone: L.timeZone })} ${formatDate(now, "time", { locale: L.locale, timeZone: L.timeZone }).replace(":", ".")}`;
  return new File([f], `${L.t("library.upload.pasted", { when })}${i ? ` (${i + 1})` : ""}.${ext}`, { type: f.type });
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** What the paste event carries, as plain values. */
function snapshotOf(e: ClipboardEvent): ClipboardSnapshot {
  const dt = e.clipboardData;
  const get = (type: string) => { try { return dt?.getData(type) || null; } catch { return null; } };
  return {
    files: pastedFiles(dt),
    text: get("text/plain"), html: get("text/html"), uriList: get("text/uri-list"),
    mozUrl: get("text/x-moz-url") ?? get("text/x-moz-url-priv"),
    inField: isTextTarget(e.target) || isTextTarget(document.activeElement),
  };
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/tiff": "tiff" };

/**
 * The clipboard read by the Paste button (navigator.clipboard.read, which asks permission or shows the browser's
 * own Paste prompt). Null when the browser doesn't let a button read it: then ⌘V / Ctrl+V is the way.
 */
async function readClipboard(): Promise<ClipboardSnapshot | null> {
  const c = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (c && typeof c.read === "function") {
    try {
      const snap: ClipboardSnapshot = { files: [] };
      for (const item of await c.read()) {
        const image = item.types.find((ty) => ty.startsWith("image/"));
        if (image) {
          const blob = await item.getType(image);
          snap.files.push(new File([blob], `image.${IMAGE_EXT[image] ?? image.split("/")[1] ?? "png"}`, { type: image }));
        }
        const text = async (ty: string) => (item.types.includes(ty) ? (await item.getType(ty)).text() : null);
        snap.text ??= await text("text/plain");
        snap.html ??= await text("text/html");
        snap.uriList ??= await text("text/uri-list");
      }
      return snap;
    } catch { /* refused or unsupported types: try plain text */ }
  }
  if (c && typeof c.readText === "function") {
    try { return { files: [], text: await c.readText() }; } catch { /* refused */ }
  }
  return null;
}

const noSubscribe = () => () => {};
/** ⌘ on Apple devices, Ctrl elsewhere (⌘ while rendering on the server). */
const useApple = () => useSyncExternalStore(noSubscribe, () => isApplePlatform(navigator as Navigator & { userAgentData?: { platform?: string } }), () => true);

/**
 * Where files come in: a large drop area (the whole window accepts a drop; ⌘V or the Paste button adds files, text
 * as a note, or a web address as a saved page),
 * the default sharing for new files, and one row per file that follows it from upload to "read".
 */
export function UploadZone({ onUploaded, statusOf, onWatching, prominent = false, family = false, folderId = null, folderName = null }: {
  /** The folder the person is looking at: new files go into it. */
  folderId?: string | null;
  folderName?: string | null;
  /** Family wording (family graph only). */
  family?: boolean;
  onUploaded?: () => void;
  /** Live state of an uploaded file, from the library list. */
  statusOf?: (sourceId: string) => SourceSummary | undefined;
  /** Tells the list to keep polling while an upload is still being read. */
  onWatching?: (watching: boolean) => void;
  /** Bigger, for an empty library. */
  prominent?: boolean;
}) {
  const L = useLx(family);
  const { t } = L;
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
        progress: 0, state: "queued", origin: "file",
        preview: file.type.startsWith("image/") && file.type !== "image/heic" && file.size < 25 * 1024 * 1024 ? URL.createObjectURL(file) : null,
      },
    }));
    for (const b of batch) {
      if (b.file.size > MAX_UPLOAD_BYTES) Object.assign(b.item, { state: "error", error: t("library.upload.tooBig", { size: formatBytes(L, b.file.size) }) });
      else if (b.file.size === 0) Object.assign(b.item, { state: "error", error: t("library.upload.empty") });
    }
    setItems((xs) => [...batch.map((b) => b.item), ...xs]);
    // Two at a time keeps progress meaningful and the server calm.
    const queue = batch.filter((b) => b.item.state === "queued");
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const { item, file } = b;
        patch(item.key, { state: "uploading" });
        const r = await uploadOne(file, visibility, sensitive, folderId, (p) => patch(item.key, { progress: p }), t("library.upload.dropped"));
        const res = r.results?.[0];
        if (res && !res.error) patch(item.key, { state: res.duplicate ? "duplicate" : "done", progress: 1, sourceId: res.sourceId });
        else patch(item.key, { state: "error", error: res?.error ?? r.error ?? (r.status === 401 ? t("library.upload.signedOut") : t("library.upload.failed")) });
        onUploaded?.();
      }
    };
    await Promise.all([worker(), worker()]);
  }, [visibility, sensitive, folderId, onUploaded, L, t]);

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

  // Text and web addresses wait for a yes (an accidental paste must not create anything); files go straight in.
  const [pending, setPending] = useState<PendingPaste | null>(null);
  const [pasteKey, setPasteKey] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const apple = useApple();

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 8000);
    return () => clearTimeout(timer);
  }, [hint]);

  /** Act on a paste: true when it was ours. */
  const take = useCallback((snap: ClipboardSnapshot): boolean => {
    const c = choosePaste(snap);
    if (c.kind === "none") return false;
    setHint(null);
    if (c.kind === "files") { void start(c.files.map((f, i) => namePasted(L, f, i))); return true; }
    setPasteKey((k) => k + 1);
    if (c.kind === "url") { setPending({ kind: "url", url: c.url, title: c.title }); return true; }
    const now = new Date();
    const title = titleFromText(c.text) ?? t("library.paste.untitled", { date: formatDate(now, "date", { locale: L.locale, timeZone: L.timeZone }) });
    setPending({ kind: "text", text: c.text, title, sourceUrl: c.sourceUrl });
    return true;
  }, [start, L, t]);

  // Paste files, screenshots, text or a web address anywhere on the page (text pasted into a field stays in the field).
  useEffect(() => {
    const paste = (e: ClipboardEvent) => { if (take(snapshotOf(e))) e.preventDefault(); };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [take]);

  // Closing the question gives focus back to the page, so the next ⌘V is ours again (not the closing title field's).
  const closePending = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPending(null);
  };

  const pasteButton = async () => {
    const snap = await readClipboard();
    if (!snap) { setHint(t(apple ? "library.paste.pressMac" : "library.paste.pressOther")); return; }
    if (!take(snap)) setHint(t("library.paste.nothing"));
  };

  const savePasted = async (p: PendingPaste, title: string) => {
    closePending();
    const key = `paste-${Math.random().toString(36).slice(2)}`;
    const item: Item = p.kind === "text"
      ? { key, name: title, size: new Blob([p.text]).size, mime: "text/plain", progress: 0, preview: null, state: "uploading", origin: "text", host: p.sourceUrl ? hostOf(p.sourceUrl) : null }
      : { key, name: title || p.url, size: null, mime: "text/html", progress: 0, preview: null, state: "uploading", origin: "url", host: hostOf(p.url) };
    setItems((xs) => [item, ...xs]);
    const payload = p.kind === "text"
      ? { kind: "text", title, text: p.text, sourceUrl: p.sourceUrl, visibility, sensitive, folderId }
      : { kind: "url", url: p.url, title: title || p.title || null, visibility, sensitive, folderId };
    let status = 0;
    let r: PasteResponse = {};
    try {
      const res = await fetch("/api/library/paste", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      status = res.status;
      r = (await res.json().catch(() => ({}))) as PasteResponse;
    } catch {
      r = { error: t("library.upload.dropped") };
    }
    if (r.sourceId && !r.error) {
      patch(key, {
        state: r.duplicate ? "duplicate" : "done", progress: 1, sourceId: r.sourceId, name: r.title || item.name,
        note: r.read === false ? t(r.webOff ? "library.paste.webOff" : "library.paste.unread") : undefined,
      });
    } else {
      patch(key, { state: "error", error: r.error ?? (status === 401 ? t("library.upload.signedOut") : t("library.paste.failed")) });
    }
    onUploaded?.();
  };

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
    return !!s && (!!s.job || ((s.status === "pending" || s.status === "processing") && !isStuck(s.status, s.startedAt, s.createdAt, s.job)));
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
                {dragging ? t("library.upload.letGo") : prominent ? t(family ? "library.upload.first" : "library.upload.firstGraph") : <><span className="sm:hidden">{t(family ? "library.upload.phone" : "library.upload.phoneGraph")}</span><span className="hidden sm:inline">{t("library.upload.desktop")}</span></>}
              </h2>
              <p className="mt-1 hidden max-w-[56ch] text-sm text-muted sm:block">
                {t(family ? "library.upload.lead" : "library.upload.leadGraph")}
              </p>
              <p className="mt-1 text-sm text-muted sm:hidden">{t("library.upload.leadPhone")}</p>
              {folderName && (
                <p className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-sm">
                  <Folder aria-hidden className="size-3.5 shrink-0 text-muted" /><span className="truncate">{t("library.folders.uploadInto", { name: folderName })}</span>
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <input ref={inputRef} id={inputId} type="file" multiple accept={ACCEPT_ATTR} className="sr-only" tabIndex={-1} aria-label={t("library.upload.choose")}
                  onChange={(e) => { void start(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                <Button type="button" onClick={() => inputRef.current?.click()}>{t("library.upload.choose")}</Button>
                <Button type="button" variant="secondary" onClick={() => void pasteButton()}>
                  <ClipboardPaste aria-hidden className="size-4" />{t("library.paste.button")}
                </Button>
                <span className="hidden text-sm text-muted sm:inline">{t("library.upload.orPaste")} <Kbd>{apple ? "⌘" : "Ctrl"}</Kbd> <Kbd>V</Kbd></span>
              </div>
              {hint && <p role="status" className="mt-2 max-w-[56ch] text-sm text-warn">{hint}</p>}
            </div>
          </div>
          <div className="min-w-0 space-y-4 lg:w-[340px]">
            <VisibilitySelect family={family} value={visibility} onChange={setVisibility} label={t("library.visibility.newFilesLabel")} />
            <SensitiveToggle family={family} checked={sensitive} onChange={setSensitive} compact />
          </div>
        </div>

        <AnimatePresence initial={false}>
          {items.length > 0 && (
            <motion.div key="queue" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="border-t border-line px-5 pb-3 pt-3 sm:px-6">
                <div className="flex items-center justify-between gap-3 py-1">
                  <p className="text-sm font-medium" aria-live="polite">
                    {uploading > 0 ? t("library.upload.uploading", { count: uploading }) : t("library.upload.addedNow", { count: items.length })}
                  </p>
                  {finished && <Button type="button" variant="ghost" size="sm" onClick={() => setItems([])}>{t("library.upload.clear")}</Button>}
                </div>
                <ul>
                  <AnimatePresence initial={false}>
                    {items.map((i) => (
                      <motion.li key={i.key} layout="position" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                        <UploadRow L={L} item={i} live={live(i)} onRemove={() => setItems((xs) => xs.filter((x) => x.key !== i.key))} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {pending && (
          <PasteConfirm key={pasteKey} L={L} pending={pending} onCancel={closePending} onSave={(title) => void savePasted(pending, title)} />
        )}
      </AnimatePresence>

      {/* Drop anywhere: a quiet layer over the page while files are dragged in. */}
      <AnimatePresence>
        {dragging && (
          <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="pointer-events-none fixed inset-0 z-40 flex items-end justify-center bg-bg/60 p-6 sm:items-center">
            <motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} exit={{ scale: 0.98 }}
              className="flex items-center gap-3 rounded-lg bg-fg px-5 py-4 text-bg shadow-float">
              <ArrowUpFromLine className="size-5" />
              <span className="font-medium">{t("library.upload.dropHere")}</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function UploadRow({ L, item: i, live, onRemove }: { L: Lx; item: Item; live?: SourceSummary; onRemove: () => void }) {
  const { t } = L;
  const category = mimeCategory(i.mime);
  const stuck = live ? isStuck(live.status, live.startedAt, live.createdAt, live.job) : false;
  const href = i.sourceId ? `/library/${i.sourceId}` : undefined;

  let line: React.ReactNode;
  let tone: "muted" | "accent" | "danger" | "warn" = "muted";
  let spinning = false;
  let done = false;
  if (i.state === "queued") line = t("library.upload.queued");
  else if (i.state === "uploading" && i.origin !== "file") { line = t(i.origin === "url" ? "library.paste.readingPage" : "library.paste.savingNote"); spinning = true; }
  else if (i.state === "uploading") { line = i.progress >= 1 ? t("library.upload.saving") : t("library.upload.progress", { pct: Math.round(i.progress * 100) }); spinning = true; }
  else if (i.state === "error") { line = i.error; tone = "danger"; }
  else if (i.state === "duplicate") line = t(i.origin === "url" ? "library.paste.duplicatePage" : i.origin === "text" ? "library.paste.duplicateNote" : "library.upload.duplicate");
  else if (i.note) { line = i.note; tone = "warn"; }
  else if (live?.duplicateOf) line = t("library.upload.sameAs", { title: live.duplicateOf.title });
  else if (!live) { line = t("library.upload.starts"); spinning = true; }
  else if (stuck) { line = t("library.upload.stuck"); tone = "warn"; }
  else if (live.job?.status === "running") { line = stepText(L, live.job.progress); tone = "accent"; spinning = true; }
  else if (live.job?.status === "queued") { line = live.job.error ? t("library.queue.retryingSoon", { reason: live.job.error }) : t("library.status.queued"); tone = live.job.error ? "warn" : "muted"; }
  else if (live.status === "pending") { line = t("library.upload.waiting"); spinning = true; }
  else if (live.status === "processing") { line = t("library.upload.reading"); tone = "accent"; spinning = true; }
  else if (live.status === "failed") { line = live.error ?? t("library.upload.readFailed"); tone = "danger"; }
  else {
    const note = extractionNote(L, live.extraction);
    line = note ? t("library.upload.notRead") : t("library.upload.read");
    tone = note ? "warn" : "muted";
    done = !note;
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="relative size-10 shrink-0 overflow-hidden rounded-md bg-surface-2 text-muted">
        {i.preview
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
          ? <img src={i.preview} alt="" className="size-full object-cover" />
          : <span className="flex size-full items-center justify-center">
            {i.origin === "url" ? <Globe aria-hidden className="size-5" /> : <TypeIcon category={category} mime={i.mime} className="size-5" />}
          </span>}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={i.name}>
            {href ? <Link href={href} className="hover:underline">{i.name}</Link> : i.name}
          </p>
          <span className="shrink-0 text-xs tabular-nums text-muted">
            {i.origin === "url" ? (i.host !== i.name ? i.host : null) : i.origin === "text" ? t("library.paste.note") : i.size != null ? formatBytes(L, i.size) : null}
          </span>
        </div>
        <p className={clsx("mt-0.5 flex items-center gap-1.5 text-xs",
          tone === "muted" && "text-muted", tone === "accent" && "text-accent", tone === "danger" && "text-danger", tone === "warn" && "text-warn")}>
          {spinning && <LoaderCircle aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />}
          {done && <Check aria-hidden className="size-3 shrink-0" />}
          <span className="min-w-0">{line}</span>
        </p>
        {(i.state === "uploading" || i.state === "queued") && i.origin === "file" && (
          <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={t("library.upload.progressLabel", { name: i.name })}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(i.progress * 100)}>
            <div className="h-full origin-left rounded-full bg-accent transition-transform duration-200 ease-out" style={{ transform: `scaleX(${i.progress})` }} />
          </div>
        )}
      </div>
      {i.state !== "uploading" && i.state !== "queued" ? (
        <button type="button" aria-label={t("library.upload.removeRow", { name: i.name })} onClick={onRemove}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <X aria-hidden className="size-4" />
        </button>
      ) : <span className="size-8 shrink-0" />}
    </div>
  );
}
