import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getNode, isUuid, type GEdge, type GNode } from "@/lib/gbrain";
import { loadNodeDetail } from "@/lib/gbrain/detail";
import { NodeChip } from "@/components/ui";
import { FactRow, ProvenancePanel, formatWhen, relationLabel, TYPE_LABEL, VISIBILITY_LABEL } from "@/components/provenance";
import { MergeSuggestions, NodeEditor } from "@/components/graph";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!isUuid(id)) return { title: "Not found · My Graph" };
  const v = await requireUser();
  const n = await getNode(v, id);
  return { title: n ? `${n.label} · My Graph` : "Not found · My Graph" };
}

export default async function NodePage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const v = await requireUser();
  const d = await loadNodeDetail(v, id);
  if (!d) notFound();
  if (d.redirectedFrom) redirect(`/node/${d.node.id}`);

  const { node } = d;
  const byId = new Map<string, GNode>([[node.id, node], ...d.neighbours.map((n) => [n.id, n] as const)]);
  const groups = new Map<string, GEdge[]>();
  for (const e of d.edges) {
    const g = groups.get(e.relation);
    if (g) g.push(e); else groups.set(e.relation, [e]);
  }
  const when = formatWhen(node.startAt, node.endAt, node.timePrecision);
  const end = (n: GNode) => ({ id: n.id, label: n.label, type: n.type });

  return (
    <article className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/graph" className="hover:text-fg hover:underline">Graph</Link>
        <span aria-hidden> / </span>
        <span className="text-fg">{node.label}</span>
      </nav>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <NodeChip type={node.type} label={TYPE_LABEL[node.type] ?? node.type} />
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">Visible to: {VISIBILITY_LABEL[node.visibility]}</span>
          {node.sensitive && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-warn">Sensitive</span>}
        </div>
        <h1 className="break-words text-2xl font-semibold tracking-tight">{node.label}</h1>
        {node.aliases.length > 0 && <p className="text-sm text-muted">Also known as {node.aliases.join(", ")}</p>}
        {node.summary ? <p className="max-w-prose">{node.summary}</p> : <p className="text-sm text-muted">No summary yet.</p>}
        {when && (
          <p className="text-sm">
            <span className="text-muted">When: </span>
            <time dateTime={node.startAt!.toISOString()}>{when}</time>
            {" · "}
            <Link href={`/timeline?at=${node.startAt!.toISOString().slice(0, 10)}`} className="text-accent hover:underline">See it on the timeline</Link>
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href={`/graph?center=${node.id}`} className="inline-flex items-center rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">
            Show in graph
          </Link>
          {d.canEdit && <NodeEditor node={{ id: node.id, label: node.label, aliases: node.aliases, summary: node.summary, visibility: node.visibility, sensitive: node.sensitive }} />}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="facts-h" className="min-w-0">
          <h2 id="facts-h" className="mb-3 text-lg font-semibold">What we know</h2>
          {groups.size === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              No connections yet. Facts appear as documents, wiki pages and conversations mention {node.label}.
            </p>
          ) : (
            <div className="space-y-5">
              {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([relation, es]) => (
                <section key={relation} aria-label={relationLabel(relation)}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{relationLabel(relation)}</h3>
                  <ul className="space-y-2">
                    {es.map((e) => {
                      const from = byId.get(e.fromId), to = byId.get(e.toId);
                      if (!from || !to) return null;
                      return (
                        <FactRow key={e.id} edge={{ id: e.id, relation: e.relation, status: e.status, confidence: e.confidence }}
                          from={end(from)} to={end(to)} provenance={d.provenance.edges[e.id] ?? []} agents={d.agents}
                          canEdit={d.canEdit || e.ownerId === v.id} />
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-6">
          <ProvenancePanel items={d.provenance.node} agents={d.agents} className="rounded-lg border border-line bg-surface-2/40 p-4"
            emptyText="No records yet — this item was created without a source." />
          {d.mergeSuggestions.length > 0 && (
            <MergeSuggestions nodeId={node.id} nodeLabel={node.label}
              suggestions={d.mergeSuggestions.map((s) => ({ other: { id: s.other.id, type: s.other.type, label: s.other.label, summary: s.other.summary }, reason: s.reason, score: s.score }))} />
          )}
        </aside>
      </div>
    </article>
  );
}
