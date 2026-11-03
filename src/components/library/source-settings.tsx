"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Button, Input } from "@/components/ui";
import type { Visibility } from "./source-meta";
import { SensitiveToggle, VisibilitySelect } from "./visibility-select";

type Props = { id: string; title: string; visibility: Visibility; sensitive: boolean; hasFile: boolean; busy: boolean };

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

export function SourceSettings(p: Props) {
  const router = useRouter();
  const titleId = useId();
  const [title, setTitle] = useState(p.title);
  const [visibility, setVisibility] = useState<Visibility>(p.visibility);
  const [sensitive, setSensitive] = useState(p.sensitive);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState<"retry" | "delete" | null>(null);

  const dirty = title.trim() !== p.title || visibility !== p.visibility || sensitive !== p.sensitive;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setMessage({ kind: "error", text: "Give the file a name." }); return; }
    setSaving(true);
    setMessage(null);
    const body: Record<string, unknown> = {};
    if (title.trim() !== p.title) body.title = title.trim();
    if (visibility !== p.visibility) body.visibility = visibility;
    if (sensitive !== p.sensitive) body.sensitive = sensitive;
    const err = await send(`/api/library/${p.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    setMessage(err ? { kind: "error", text: err } : { kind: "ok", text: "Saved." });
    if (!err) router.refresh();
  };

  const retry = async () => {
    setWorking("retry");
    const err = await send(`/api/library/${p.id}/reprocess`, { method: "POST" });
    setWorking(null);
    setMessage(err ? { kind: "error", text: err } : { kind: "ok", text: "Reading the file again." });
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
    <div className="space-y-4">
      <form onSubmit={save} className="space-y-3">
        <div>
          <label htmlFor={titleId} className="mb-1 block text-sm font-medium">Name</label>
          <Input id={titleId} value={title} maxLength={250} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <VisibilitySelect value={visibility} onChange={setVisibility} />
        <SensitiveToggle checked={sensitive} onChange={setSensitive} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty || saving}>{saving ? "Saving…" : "Save changes"}</Button>
          {message && <p role={message.kind === "error" ? "alert" : "status"} className={clsx("text-sm", message.kind === "error" ? "text-danger" : "text-muted")}>{message.text}</p>}
        </div>
        {visibility !== p.visibility && (
          <p className="text-xs text-muted">This changes who can see the file. People, places and facts already found in it keep their own settings.</p>
        )}
      </form>

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {p.hasFile && (
          <a href={`/api/files/${p.id}?download=1`} className="inline-flex items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">
            <Download aria-hidden className="size-4" />Download original
          </a>
        )}
        <Button type="button" variant="secondary" onClick={retry} disabled={p.busy || working !== null}>
          <RefreshCw aria-hidden className={clsx("size-4", working === "retry" && "motion-safe:animate-spin")} />Read again
        </Button>
        {!confirming ? (
          <Button type="button" variant="ghost" className="text-danger" onClick={() => setConfirming(true)} disabled={working !== null}>
            <Trash2 aria-hidden className="size-4" />Delete
          </Button>
        ) : (
          <div role="alertdialog" aria-label="Confirm delete" className="w-full rounded-md border border-line bg-surface-2 p-3 text-sm">
            <p>Delete this file and its search index? People, places and events found in it stay in the graph, but lose this file as a source.</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="danger" onClick={remove} disabled={working !== null} autoFocus>{working === "delete" ? "Deleting…" : "Delete file"}</Button>
              <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={working !== null}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
