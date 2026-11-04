"use client";
import { useState } from "react";
import { motion } from "motion/react";
import { clsx } from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, PersonChip, NodeChip, Textarea } from "@/components/ui";
import type { MemoryView } from "@/lib/memory/types";
import { MEMORY_MAX_CHARS } from "@/lib/memory/pure";

const VIS_LABEL = { private: "Only you", parents: "Parents only", household: null } as const;

export function usedLabel(m: Pick<MemoryView, "lastUsedAt" | "status">): string {
  if (m.status === "pending") return "Not used until you confirm it";
  if (!m.lastUsedAt) return "Not used yet";
  return `Used ${formatDistanceToNowStrict(new Date(m.lastUsedAt), { addSuffix: true })}`;
}

/** One memory: what it says, who it applies to, where it came from, when it was last used, and edit / pause / forget. */
export function MemoryItem({ m, onUpdate, onRemove, hideAbout, compact }: {
  m: MemoryView;
  onUpdate: (id: string, patch: { text?: string; status?: "active" | "paused" }) => Promise<unknown>;
  onRemove: (m: MemoryView) => void;
  /** On a person's page every memory is about them; don't repeat their chip. */
  hideAbout?: string;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = m.status === "paused";
  const about = m.about.filter((a) => a.id !== hideAbout);

  async function run(patch: { text?: string; status?: "active" | "paused" }) {
    setBusy(true); setError(null);
    try {
      await onUpdate(m.id, patch);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const text = draft.trim();
    if (text === m.text) { setEditing(false); return; }
    if (text.length < 2) { setError("Write what the assistant should remember."); return; }
    if (await run({ text })) setEditing(false);
  }

  return (
    <motion.li layout="position" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={clsx("group list-none", compact ? "py-2.5" : "py-3.5")}>
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-2">
          <Textarea autoFocus aria-label="What the assistant should remember" rows={2} maxLength={MEMORY_MAX_CHARS} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setEditing(false); setDraft(m.text); setError(null); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            }} />
          <div className="flex items-center gap-2">
            <Button size="sm" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setDraft(m.text); setError(null); }}>Cancel</Button>
            {error && <span role="alert" className="text-sm text-danger">{error}</span>}
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={clsx("text-[15px] leading-snug", paused && "text-muted")}>{m.text}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
              {about.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                  {about.map((a) => a.type === "person"
                    ? <PersonChip key={a.id} id={a.id} name={a.label} href={`/people/${a.id}`} />
                    : <NodeChip key={a.id} type={a.type} label={a.label} href={`/node/${a.id}`} />)}
                </span>
              )}
              {m.from.href
                ? <a href={m.from.href} className="text-accent hover:underline">{m.from.label}</a>
                : <span>{m.from.label}</span>}
              <span>{usedLabel(m)}</span>
              {VIS_LABEL[m.visibility] && <span>{VIS_LABEL[m.visibility]}</span>}
              {paused && <Badge>Paused</Badge>}
            </div>
            {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
          </div>
          {m.canEdit && (
            <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              <IconButton label="Edit" onClick={() => { setDraft(m.text); setEditing(true); }}><Pencil className="size-4" /></IconButton>
              {m.status !== "pending" && (
                <IconButton label={paused ? "Use this again" : "Pause: don't use this for now"} disabled={busy}
                  onClick={() => void run({ status: paused ? "active" : "paused" })}>
                  {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                </IconButton>
              )}
              <IconButton label="Forget this" onClick={() => onRemove(m)}><Trash2 className="size-4" /></IconButton>
            </div>
          )}
        </div>
      )}
    </motion.li>
  );
}
