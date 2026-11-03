"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Button, buttonClass, Input } from "@/components/ui";
import type { Visibility } from "./source-meta";
import { SensitiveToggle, VisibilitySelect } from "./visibility-select";

type Props = { id: string; title: string; visibility: Visibility; sensitive: boolean; hasFile: boolean; busy: boolean };
type Message = { kind: "ok" | "error"; text: string } | null;

async function send(url: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body.error ?? "That didn't work. Please try again.";
  } catch {
    return "The connection dropped. Check your network and try again.";
  }
}

const patchSource = (id: string, body: Record<string, unknown>) =>
  send(`/api/library/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function Note({ m }: { m: Message }) {
  if (!m) return null;
  return <p role={m.kind === "error" ? "alert" : "status"} className={clsx("text-sm", m.kind === "error" ? "text-danger" : "text-muted")}>{m.text}</p>;
}

/** Who can see the file. Each choice saves as soon as it is made. */
export function SharingSettings({ id, visibility: v0, sensitive: s0 }: Pick<Props, "id" | "visibility" | "sensitive">) {
  const router = useRouter();
  const [visibility, setVisibility] = useState<Visibility>(v0);
  const [sensitive, setSensitive] = useState(s0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => { setVisibility(v0); setSensitive(s0); }, [v0, s0]);

  const save = async (body: { visibility?: Visibility; sensitive?: boolean }, undo: () => void) => {
    setSaving(true);
    setMessage(null);
    const err = await patchSource(id, body);
    setSaving(false);
    if (err) { undo(); setMessage({ kind: "error", text: err }); return; }
    setMessage({ kind: "ok", text: "Saved. People, places and facts found in the file keep their own sharing." });
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <VisibilitySelect value={visibility} disabled={saving} label="Who can see this file"
        onChange={(next) => {
          if (next === visibility) return;
          const prev = visibility;
          setVisibility(next);
          void save({ visibility: next }, () => setVisibility(prev));
        }} />
      <SensitiveToggle checked={sensitive} disabled={saving}
        onChange={(next) => { setSensitive(next); void save({ sensitive: next }, () => setSensitive(!next)); }} />
      <Note m={message} />
    </div>
  );
}

/** Rename, download, read again, delete. */
export function SourceSettings(p: Props) {
  const router = useRouter();
  const titleId = useId();
  const [title, setTitle] = useState(p.title);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState<"retry" | "delete" | null>(null);

  const dirty = title.trim() !== p.title;

  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setMessage({ kind: "error", text: "Give the file a name." }); return; }
    if (!dirty) return;
    setSaving(true);
    setMessage(null);
    const err = await patchSource(p.id, { title: title.trim() });
    setSaving(false);
    setMessage(err ? { kind: "error", text: err } : { kind: "ok", text: "Renamed." });
    if (!err) router.refresh();
  };

  const retry = async () => {
    setWorking("retry");
    const err = await send(`/api/library/${p.id}/reprocess`, { method: "POST" });
    setWorking(null);
    setMessage(err ? { kind: "error", text: err } : { kind: "ok", text: "Reading the file again. This page updates by itself." });
    router.refresh();
  };

  const remove = async () => {
    setWorking("delete");
    const err = await send(`/api/library/${p.id}`, { method: "DELETE" });
    if (err) {
      setWorking(null);
      setConfirming(false);
      setMessage({ kind: "error", text: err });
      return;
    }
    router.push("/library");
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <form onSubmit={rename}>
        <label htmlFor={titleId} className="mb-1.5 block text-sm font-medium">Name</label>
        <div className="flex gap-2">
          <Input id={titleId} value={title} maxLength={250} onChange={(e) => setTitle(e.target.value)} />
          {dirty && <Button type="submit" disabled={saving} className="shrink-0">{saving ? "Saving…" : "Rename"}</Button>}
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {p.hasFile && (
          <a href={`/api/files/${p.id}?download=1`} className={buttonClass("secondary")}>
            <Download aria-hidden className="size-4" />Download original
          </a>
        )}
        <Button type="button" variant="secondary" onClick={retry} disabled={p.busy || working !== null}>
          <RefreshCw aria-hidden className={clsx("size-4", working === "retry" && "motion-safe:animate-spin")} />Read again
        </Button>
        {!confirming && (
          <Button type="button" variant="ghost" className="text-danger hover:text-danger" onClick={() => setConfirming(true)} disabled={working !== null}>
            <Trash2 aria-hidden className="size-4" />Delete
          </Button>
        )}
      </div>
      <Note m={message} />

      <AnimatePresence initial={false}>
        {confirming && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div role="alertdialog" aria-label="Delete this file?" className="rounded-lg bg-danger-tint p-4 text-sm">
              <p className="font-medium text-danger">Delete this file?</p>
              <p className="mt-1 text-fg/80">The original and its search text are removed. People, places and events found in it stay in the family&apos;s graph, but lose this file as their source.</p>
              <div className="mt-3 flex gap-2">
                <Button type="button" variant="danger" onClick={remove} disabled={working !== null} autoFocus>{working === "delete" ? "Deleting…" : "Delete file"}</Button>
                <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={working !== null}>Keep it</Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
