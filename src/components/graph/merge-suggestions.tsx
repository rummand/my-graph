"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { NodePill } from "./node-mark";

export type MergeSuggestionView = { other: { id: string; type: string; label: string; summary: string | null }; reason: string; score: number };

/** "Could these be the same?": merge the other item into this one, or say they're different. */
export function MergeSuggestions({ nodeId, nodeLabel, suggestions }: { nodeId: string; nodeLabel: string; suggestions: MergeSuggestionView[] }) {
  const router = useRouter();
  const t = useT();
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = suggestions.filter((s) => !gone.has(s.other.id));
  if (list.length === 0) return null;

  async function run(otherId: string, kind: "merge" | "dismiss") {
    if (kind === "merge" && !window.confirm(t("graph.merge.confirm", { name: nodeLabel }))) return;
    setBusy(`${kind}:${otherId}`);
    setError(null);
    try {
      const res = kind === "merge"
        ? await fetch(`/api/nodes/${nodeId}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dropId: otherId }) })
        : await fetch(`/api/nodes/merge-suggestions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aId: nodeId, bId: otherId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("graph.fact.couldNotSave"));
      setGone((g) => new Set(g).add(otherId));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("graph.fact.couldNotSave"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="merge-h" className="rounded-lg bg-warn-tint/50 p-4">
      <h2 id="merge-h" className="font-semibold">{t("graph.merge.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("graph.merge.lead")}</p>
      <ul className="mt-4 space-y-4">
        {list.map((s) => (
          <li key={s.other.id} className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <NodePill id={s.other.id} type={s.other.type} label={s.other.label} href={`/node/${s.other.id}`} />
              <span className="text-xs tabular-nums text-muted">{t("graph.merge.alike", { pct: Math.round(s.score * 100) })}</span>
            </div>
            <p className="mt-1.5 text-muted">{s.reason}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => run(s.other.id, "merge")}>
                {busy === `merge:${s.other.id}` ? t("graph.merge.merging") : t("graph.merge.merge")}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => run(s.other.id, "dismiss")}>
                {busy === `dismiss:${s.other.id}` ? t("graph.merge.saving") : t("graph.merge.dismiss")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="mt-2 text-sm text-danger empty:hidden">{error}</p>
    </section>
  );
}
