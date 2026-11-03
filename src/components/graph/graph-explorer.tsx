"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Button, Card, EmptyState, Input, NodeChip } from "@/components/ui";
import { normalizeLabel } from "@/lib/gbrain/pure";
import { relationLabel, TYPE_LABEL } from "@/components/provenance/labels";
import { NODE_TYPES, type GraphData, type GraphNodeData } from "./types";

const GraphCanvas = dynamic(() => import("./graph-canvas"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">Drawing the graph…</div>,
});

const TYPE_VAR: Record<string, string> = Object.fromEntries(NODE_TYPES.map((t) => [t, `var(--t-${t})`]));

/** The interactive graph: type filters, search, list fallback and a side panel for the selected node. */
export function GraphExplorer({ data, centerId, truncated }: { data: GraphData; centerId: string | null; truncated: boolean }) {
  const router = useRouter();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(centerId);
  const [view, setView] = useState<"graph" | "list">("graph");

  useEffect(() => setSelectedId(centerId), [centerId]);

  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of data.nodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [data]);

  const q = normalizeLabel(query);
  const matchIds = useMemo(() => {
    if (!q) return new Set<string>();
    return new Set(data.nodes.filter((n) => !hidden.has(n.type) && [n.label, ...n.aliases].some((s) => normalizeLabel(s).includes(q))).map((n) => n.id));
  }, [data, q, hidden]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const selectedFacts = useMemo(() => {
    if (!selected) return [];
    return data.edges
      .filter((e) => e.from === selected.id || e.to === selected.id)
      .map((e) => ({ edge: e, other: byId.get(e.from === selected.id ? e.to : e.from), out: e.from === selected.id }))
      .filter((f): f is typeof f & { other: GraphNodeData } => !!f.other);
  }, [selected, data, byId]);

  const toggle = (t: string) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = [...matchIds][0];
      if (first) setSelectedId(first);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  }

  if (data.nodes.length === 0) {
    return (
      <EmptyState title={centerId ? "Nothing to show around this item" : "Your graph is empty"}>
        {centerId ? (
          <Link href="/graph" className="text-accent hover:underline">Show the whole graph</Link>
        ) : (
          <>
            People, places and events appear here as you add documents to the{" "}
            <Link href="/library" className="text-accent hover:underline">library</Link>, write{" "}
            <Link href="/wiki" className="text-accent hover:underline">wiki pages</Link> or tell the{" "}
            <Link href="/chat" className="text-accent hover:underline">assistant</Link> about them.
          </>
        )}
      </EmptyState>
    );
  }

  const visibleNodes = data.nodes.filter((n) => !hidden.has(n.type) && (!q || matchIds.has(n.id)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Find in graph</span>
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
            placeholder="Find a person, place or event…" aria-describedby="graph-search-status" />
        </label>
        <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="View">
          {(["graph", "list"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={view === m} onClick={() => setView(m)}
              className={clsx("rounded px-3 py-1.5 text-sm", view === m ? "bg-accent-tint font-medium text-accent" : "text-muted hover:text-fg")}>
              {m === "graph" ? "Graph" : "List"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show types">
        {NODE_TYPES.filter((t) => counts[t]).map((t) => {
          const on = !hidden.has(t);
          return (
            <button key={t} type="button" aria-pressed={on} onClick={() => toggle(t)}
              className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                on ? "bg-surface" : "border-dashed bg-transparent text-muted line-through")}
              style={on ? { borderColor: TYPE_VAR[t], color: TYPE_VAR[t] } : undefined}>
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: TYPE_VAR[t], opacity: on ? 1 : 0.4 }} />
              {TYPE_LABEL[t]} <span className="opacity-70">{counts[t]}</span>
            </button>
          );
        })}
        <p id="graph-search-status" aria-live="polite" className="ml-auto text-xs text-muted">
          {q ? (matchIds.size ? `${matchIds.size} match${matchIds.size === 1 ? "" : "es"} — press Enter to jump to the first` : "No matches in this view") : `${data.nodes.length} items · ${data.edges.length} facts`}
          {truncated && !q && " (showing the best-connected)"}
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        {view === "graph" ? (
          <div className="relative h-[60vh] min-h-[360px] overflow-hidden rounded-lg border border-line bg-surface">
            <GraphCanvas data={data} hiddenTypes={hidden} query={q} matchIds={matchIds} selectedId={selectedId}
              onSelect={setSelectedId} label={`Graph of ${data.nodes.length} items and ${data.edges.length} facts. Use the list view for a readable version.`} />
            <Legend />
          </div>
        ) : (
          <Card className="max-h-[60vh] min-h-[360px] overflow-auto p-0">
            {visibleNodes.length === 0 ? (
              <p className="p-4 text-sm text-muted">Nothing matches. Clear the search or turn a type back on.</p>
            ) : (
              <ul className="divide-y divide-line">
                {visibleNodes.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => setSelectedId(n.id)} aria-current={selectedId === n.id}
                      className={clsx("flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-surface-2", selectedId === n.id && "bg-accent-tint")}>
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: TYPE_VAR[n.type] }} />
                      <span className="min-w-0 flex-1 truncate">{n.label}</span>
                      <span className="text-xs text-muted">{TYPE_LABEL[n.type]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <aside aria-label="Selected item" className="min-w-0">
          {selected ? (
            <Card className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <NodeChip type={selected.type} label={TYPE_LABEL[selected.type] ?? selected.type} />
                  <h2 className="mt-1 break-words text-lg font-semibold">{selected.label}</h2>
                  {selected.aliases.length > 0 && <p className="text-xs text-muted">Also known as {selected.aliases.join(", ")}</p>}
                </div>
                <Button variant="ghost" className="px-2 py-1" aria-label="Close" onClick={() => setSelectedId(null)}>×</Button>
              </div>
              <p className="text-sm">{selected.summary || <span className="text-muted">No summary yet.</span>}</p>
              {selectedFacts.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Connections</h3>
                  <ul className="space-y-1 text-sm">
                    {selectedFacts.slice(0, 8).map(({ edge, other, out }) => (
                      <li key={edge.id} className="flex flex-wrap items-center gap-1">
                        <span className={clsx("text-muted", edge.status === "inferred" && "text-inferred italic")}>
                          {out ? relationLabel(edge.relation) : `${relationLabel(edge.relation)} (from)`}
                        </span>
                        <button type="button" className="text-left text-accent hover:underline" onClick={() => setSelectedId(other.id)}>{other.label}</button>
                      </li>
                    ))}
                  </ul>
                  {selectedFacts.length > 8 && <p className="mt-1 text-xs text-muted">and {selectedFacts.length - 8} more on its page</p>}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Link href={`/node/${selected.id}`} className="inline-flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90">
                  Open page
                </Link>
                {centerId !== selected.id && (
                  <Button variant="secondary" onClick={() => router.push(`/graph?center=${selected.id}`)}>Focus here</Button>
                )}
              </div>
            </Card>
          ) : (
            <Card className="text-sm text-muted">
              Select a dot to see what we know about it. Drag to move around, scroll or pinch to zoom.
            </Card>
          )}
          {centerId && (
            <p className="mt-3 text-sm"><Link href="/graph" className="text-accent hover:underline">← Show the whole graph</Link></p>
          )}
        </aside>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-surface/90 px-2 py-1 text-[11px] text-muted">
      <span className="flex items-center gap-1"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="var(--muted)" strokeWidth="2" /></svg>Confirmed</span>
      <span className="flex items-center gap-1"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="var(--line)" strokeWidth="2" /></svg>Not yet confirmed</span>
      <span className="flex items-center gap-1"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="var(--inferred)" strokeWidth="2" strokeDasharray="4 3" /></svg>A guess</span>
    </div>
  );
}
