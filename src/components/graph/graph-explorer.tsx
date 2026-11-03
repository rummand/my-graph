"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Crosshair, Search, X } from "lucide-react";
import { Avatar, EmptyState, IconButton, Tabs, buttonClass } from "@/components/ui";
import { normalizeLabel } from "@/lib/gbrain/pure";
import { relationLabel, sentenceCase, TYPE_LABEL } from "@/components/provenance/labels";
import { NodeMark, NodePill } from "./node-mark";
import { NODE_TYPES, TYPE_PLURAL, type GraphData, type GraphEdgeData, type GraphNodeData } from "./types";

const GraphCanvas = dynamic(() => import("./graph-canvas"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">Drawing the graph…</div>,
});

type Connection = { edge: GraphEdgeData; other: GraphNodeData; label: string };

/** The interactive graph: type filters, search, a list view and a side panel for the selected node. */
export function GraphExplorer({ data, centerId, truncated }: { data: GraphData; centerId: string | null; truncated: boolean }) {
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
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of data.edges) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  }, [data]);

  const q = normalizeLabel(query);
  const matchIds = useMemo(() => {
    if (!q) return new Set<string>();
    return new Set(data.nodes.filter((n) => !hidden.has(n.type) && [n.label, ...n.aliases].some((s) => normalizeLabel(s).includes(q))).map((n) => n.id));
  }, [data, q, hidden]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const connections = useMemo(() => {
    if (!selected) return [] as [string, Connection[]][];
    const groups = new Map<string, Connection[]>();
    for (const e of data.edges) {
      if (e.from !== selected.id && e.to !== selected.id) continue;
      const out = e.from === selected.id;
      const other = byId.get(out ? e.to : e.from);
      if (!other) continue;
      const label = sentenceCase(out ? e.label ?? relationLabel(e.relation) : e.inverseLabel ?? `${relationLabel(e.relation)} (from)`);
      const g = groups.get(label);
      const c = { edge: e, other, label };
      if (g) g.push(c); else groups.set(label, [c]);
    }
    return [...groups.entries()];
  }, [selected, data, byId]);

  const people = useMemo(() => data.nodes.filter((n) => n.type === "person").sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)), [data, degree]);
  const statuses = useMemo(() => new Set(data.edges.map((e) => e.status)), [data]);

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
      <EmptyState title={centerId ? "Nothing connects to this yet" : "Your graph is empty"}>
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

  const visibleNodes = data.nodes
    .filter((n) => !hidden.has(n.type) && (!q || matchIds.has(n.id)))
    .sort((a, b) => NODE_TYPES.indexOf(a.type as never) - NODE_TYPES.indexOf(b.type as never) || a.label.localeCompare(b.label));
  const status = q
    ? matchIds.size ? `${matchIds.size} found, press Enter to go to the first` : "Nothing by that name here"
    : `${data.nodes.length} things and ${data.edges.length} connections${truncated ? ", the best-connected shown" : ""}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="relative min-w-0 flex-1 basis-60 sm:max-w-sm">
          <span className="sr-only">Find in graph</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
            placeholder="Find a person, place or event" aria-describedby="graph-search-status"
            className="h-9 w-full rounded-md bg-surface pl-8 pr-3 text-[15px] text-fg ring-1 ring-inset ring-line placeholder:text-muted/80 hover:ring-muted/40 focus:outline-none focus:ring-2 focus:ring-accent" />
        </label>
        <div className="-mx-4 flex min-w-0 basis-full gap-1 overflow-x-auto px-4 sm:mx-0 sm:basis-auto sm:flex-1 sm:flex-wrap sm:px-0" role="group" aria-label="Show on the graph">
          {NODE_TYPES.filter((t) => counts[t]).map((t) => {
            const on = !hidden.has(t);
            return (
              <button key={t} type="button" aria-pressed={on} onClick={() => toggle(t)}
                className={clsx("inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-sm transition-colors duration-150",
                  on ? "bg-surface text-fg" : "text-muted hover:bg-surface-2")}>
                <span aria-hidden className={clsx("size-2 rounded-full transition-opacity", !on && "opacity-30")}
                  style={{ background: t === "person" ? "var(--fg)" : `var(--t-${t})` }} />
                {TYPE_PLURAL[t]}
                <span className="tabular-nums text-muted">{counts[t]}</span>
              </button>
            );
          })}
        </div>
        <Tabs className="ml-auto" value={view} onSelect={setView} items={[{ value: "graph", label: "Map" }, { value: "list", label: "List" }]} />
      </div>

      <div className="grid gap-3 lg:h-[calc(100dvh-14rem)] lg:min-h-[520px] lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="relative h-[58dvh] min-h-[340px] overflow-hidden rounded-lg bg-surface lg:h-auto">
          {view === "graph" ? (
            <GraphCanvas data={data} hiddenTypes={hidden} query={q} matchIds={matchIds} selectedId={selectedId}
              onSelect={setSelectedId} label={`Graph of ${data.nodes.length} things and ${data.edges.length} connections. The list view has the same in readable form.`} />
          ) : visibleNodes.length === 0 ? (
            <p className="p-5 text-sm text-muted">Nothing matches. Clear the search or turn a type back on.</p>
          ) : (
            <ul className="h-full overflow-auto py-1.5">
              {visibleNodes.map((n, i) => (
                <li key={n.id}>
                  {(i === 0 || visibleNodes[i - 1].type !== n.type) && (
                    <p className="px-4 pb-1 pt-3 text-sm font-medium text-muted">{TYPE_PLURAL[n.type] ?? n.type}</p>
                  )}
                  <button type="button" onClick={() => setSelectedId(n.id)} aria-current={selectedId === n.id}
                    className={clsx("flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface-2",
                      selectedId === n.id && "bg-accent-tint")}>
                    <NodeMark id={n.id} type={n.type} size={9} />
                    <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    <span className="text-sm tabular-nums text-muted">{degree.get(n.id) ?? 0} {(degree.get(n.id) ?? 0) === 1 ? "connection" : "connections"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p id="graph-search-status" aria-live="polite"
            className="pointer-events-none absolute left-3 top-3 rounded-md bg-surface/85 px-2 py-1 text-xs text-muted">
            {view === "graph" ? status : null}
          </p>
        </div>

        <aside aria-label="Selected" className="min-w-0 lg:overflow-y-auto">
          <AnimatePresence mode="wait" initial={false}>
            {selected ? (
              <motion.div key={selected.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="rounded-lg bg-surface p-5">
                <div className="flex items-start gap-3">
                  {selected.type === "person"
                    ? <Avatar id={selected.id} name={selected.label} size={40} />
                    : <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2"><NodeMark id={selected.id} type={selected.type} size={12} /></span>}
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-lg/6 font-semibold tracking-[-0.01em]">{selected.label}</h2>
                    <p className="text-sm text-muted">{selected.kindLabel ? sentenceCase(selected.kindLabel) : TYPE_LABEL[selected.type] ?? selected.type}</p>
                  </div>
                  <IconButton label="Close" className="-mr-2 -mt-1" onClick={() => setSelectedId(null)}><X className="size-4" /></IconButton>
                </div>
                {selected.aliases.length > 0 && <p className="mt-3 text-sm text-muted">Also known as {selected.aliases.join(", ")}</p>}
                <p className={clsx("mt-3 text-[15px]", !selected.summary && "text-sm text-muted")}>{selected.summary || "No summary yet."}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href={`/node/${selected.id}`} className={buttonClass("primary", "sm")}>Open page <ArrowRight className="size-4" /></Link>
                  {centerId !== selected.id && (
                    <Link href={`/graph?center=${selected.id}`} className={buttonClass("secondary", "sm")}><Crosshair className="size-4" /> Focus here</Link>
                  )}
                </div>

                {connections.length > 0 && (
                  <div className="mt-5 space-y-3 border-t border-line/70 pt-4">
                    {connections.slice(0, 6).map(([label, cs]) => (
                      <div key={label}>
                        <h3 className="mb-1.5 text-sm text-muted">{label}</h3>
                        <div className="flex flex-wrap gap-1.5">
                          {cs.slice(0, 8).map(({ edge, other }) => (
                            <NodePill key={edge.id} id={other.id} type={other.type} label={other.label} onClick={() => setSelectedId(other.id)}
                              className={clsx(edge.status === "inferred" && "outline-1 outline-dashed outline-inferred/60", edge.status === "unconfirmed" && "opacity-75")} />
                          ))}
                          {cs.length > 8 && <span className="self-center text-sm text-muted">and {cs.length - 8} more</span>}
                        </div>
                      </div>
                    ))}
                    {connections.length > 6 && <p className="text-sm text-muted">More on its page.</p>}
                  </div>
                )}

              </motion.div>
            ) : (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
                className="space-y-6 px-1 pt-1">
                {people.length > 0 && (
                  <section>
                    <h2 className="mb-2 font-semibold">People here</h2>
                    <div className="flex flex-wrap gap-1.5">
                      {people.slice(0, 14).map((p) => <NodePill key={p.id} id={p.id} type="person" label={p.label} onClick={() => setSelectedId(p.id)} />)}
                    </div>
                  </section>
                )}
                <p className="text-sm text-muted">
                  Pick anyone to see who and what they connect to. Hover a dot to light up its neighbours; drag to move around, scroll or pinch to zoom.
                </p>
                <Legend statuses={statuses} />
              </motion.div>
            )}
          </AnimatePresence>
          {centerId && (
            <p className="mt-4 px-1 text-sm"><Link href="/graph" className="text-accent hover:underline">Show the whole graph</Link></p>
          )}
        </aside>
      </div>
    </div>
  );
}

function Legend({ statuses }: { statuses: Set<string> }) {
  const rows = [
    { key: "confirmed", label: "Confirmed", stroke: "var(--muted)", dash: undefined, opacity: 0.6 },
    { key: "unconfirmed", label: "Not confirmed yet", stroke: "var(--muted)", dash: "2 3", opacity: 0.7 },
    { key: "inferred", label: "The assistant's guess", stroke: "var(--inferred)", dash: "5 4", opacity: 1 },
  ].filter((r) => statuses.has(r.key));
  if (rows.length < 2) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">Lines</h2>
      <ul className="space-y-1.5 text-sm text-muted">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2.5">
            <svg width="28" height="6" aria-hidden><line x1="0" y1="3" x2="28" y2="3" stroke={r.stroke} strokeOpacity={r.opacity} strokeWidth="1.5" strokeDasharray={r.dash} /></svg>
            {r.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
