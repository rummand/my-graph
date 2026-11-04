import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CalendarDays, Crosshair, Eye, Lock, Users } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getNode, isUuid, type GEdge, type GNode } from "@/lib/gbrain";
import { loadNodeDetail } from "@/lib/gbrain/detail";
import { getMeta } from "@/lib/meta";
import { Avatar, Badge, buttonClass } from "@/components/ui";
import { FactRow, ProvenancePanel, formatWhen, sentenceCase, typeLabel } from "@/components/provenance";
import { HistoryPanel, WhoSaid } from "@/components/history";
import { scopeOf } from "@/lib/graphs/pure";
import { getLocale, getT } from "@/lib/i18n";
import { MergeSuggestions, NodeEditor, NodeMark } from "@/components/graph";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { memoryAllowed } from "@/lib/memory";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await getT();
  if (!isUuid(id)) return { title: `${t("graph.node.notFound")} · My Graph` };
  const v = await requireUser();
  const n = await getNode(v, id);
  return { title: n ? `${n.label} · My Graph` : `${t("graph.node.notFound")} · My Graph` };
}

export default async function NodePage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const v = await requireUser();
  const [d, meta, t, locale] = await Promise.all([loadNodeDetail(v, id), getMeta(v), getT(), getLocale()]);
  const family = scopeOf(v).family;
  if (!d) notFound();
  if (d.redirectedFrom) redirect(`/node/${d.node.id}`);

  const { node } = d;
  const byId = new Map<string, GNode>([[node.id, node], ...d.neighbours.map((n) => [n.id, n] as const)]);

  // Group facts by how they read from this node: "Child of", "Attends", "Mentioned in".
  const groups = new Map<string, GEdge[]>();
  for (const e of d.edges) {
    if (!byId.has(e.fromId) || !byId.has(e.toId)) continue;
    const label = sentenceCase(meta.relationLabel(e.relation, e.fromId === node.id ? "out" : "in"));
    const g = groups.get(label);
    if (g) g.push(e); else groups.set(label, [e]);
  }
  const otherOf = (e: GEdge) => byId.get(e.fromId === node.id ? e.toId : e.fromId)!;
  const ordered = [...groups.entries()]
    .map(([label, es]) => [label, es.sort((a, b) => rank(a.status) - rank(b.status) || otherOf(a).label.localeCompare(otherOf(b).label))] as const)
    .sort(([la, a], [lb, b]) => peopleFirst(a, otherOf) - peopleFirst(b, otherOf) || b.length - a.length || la.localeCompare(lb));
  const toCheck = d.edges.filter((e) => e.status === "unconfirmed" || e.status === "inferred").length;
  const sourceCount = new Set(Object.values(d.provenance.edges).flat().concat(d.provenance.node).map((p) => p.sourceId).filter(Boolean)).size;

  const when = formatWhen(node.startAt, node.endAt, node.timePrecision, locale);
  const end = (n: GNode) => ({ id: n.id, label: n.label, type: n.type });
  const kindLabel = meta.kind(node.type, node.kind)?.label;
  const typeLine = kindLabel ? sentenceCase(kindLabel) : typeLabel(node.type, t);
  const seenBy = node.visibility === "private"
    ? { icon: Lock, text: node.ownerId === v.id ? t("graph.seenBy.youOnly") : t("graph.seenBy.privateOther") }
    : node.visibility === "parents"
      ? { icon: Eye, text: family ? t("graph.seenBy.parents") : t("graph.seenBy.editors") }
      : { icon: Users, text: family ? t("graph.seenBy.household") : t("graph.seenBy.everyone") };
  const allProvenance = [...d.provenance.node, ...Object.values(d.provenance.edges).flat()];

  return (
    <article>
      <Link href={`/graph?center=${node.id}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> {t("graph.title")}
      </Link>

      <header className="mb-10 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-x-5">
        {node.type === "person"
          ? <Avatar id={node.id} name={node.label} size={64} />
          : <span className="grid size-16 place-items-center rounded-full bg-surface"><NodeMark id={node.id} type={node.type} size={18} /></span>}
        <div className="min-w-0 self-center">
          <h1 className="break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{node.label}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="text-fg">{typeLine}</span>
            <span className="inline-flex items-center gap-1.5"><seenBy.icon className="size-3.5" />{seenBy.text}</span>
            {node.sensitive && <Badge tone="warn">{t("graph.node.sensitive")}</Badge>}
          </div>
        </div>
        <div className="col-span-2 flex flex-wrap items-start gap-2 sm:col-span-1 sm:justify-end">
          <Link href={`/graph?center=${node.id}`} className={buttonClass("secondary")}><Crosshair className="size-4" /> {t("graph.node.showConnections")}</Link>
          {d.canEdit && <NodeEditor node={{ id: node.id, label: node.label, aliases: node.aliases, summary: node.summary, visibility: node.visibility, sensitive: node.sensitive }} family={family} />}
        </div>

        <div className="col-span-2 space-y-2 sm:col-span-3 sm:col-start-1 lg:col-span-2 lg:col-start-2">
          {node.aliases.length > 0 && <p className="text-sm text-muted">{t("graph.explorer.alsoKnownAs", { names: node.aliases.join(", ") })}</p>}
          {node.summary
            ? <p className="max-w-[65ch] text-base/7">{node.summary}</p>
            : <p className="text-sm text-muted">{d.canEdit ? t("graph.node.noSummaryEdit") : t("graph.node.noSummary")}</p>}
          {when && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4 text-muted" /><time dateTime={node.startAt!.toISOString()}>{when}</time></span>
              <Link href={`/timeline?at=${node.startAt!.toISOString().slice(0, 10)}`} className="text-accent hover:underline">{t("graph.node.onTimeline")}</Link>
            </p>
          )}
        </div>
      </header>

      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="facts-h" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="facts-h" className="text-lg font-semibold tracking-[-0.01em]">{t("graph.node.whatWeKnow")}</h2>
            {d.edges.length > 0 && (
              <p className="text-sm text-muted">
                <span className="tabular-nums">{t("graph.node.factsFrom", { facts: t("graph.node.facts", { count: d.edges.length }), sources: t("graph.node.sources", { count: sourceCount }) })}</span>
                {toCheck > 0 && <>, <span className="font-medium tabular-nums text-warn">{t("graph.node.toCheck", { count: toCheck })}</span></>}
              </p>
            )}
          </div>
          {ordered.length === 0 ? (
            <div className="rounded-lg bg-surface-2/60 px-6 py-10 text-center">
              <p className="font-medium">{t("graph.node.nothingConnects", { name: node.label })}</p>
              <p className="mx-auto mt-1.5 max-w-[48ch] text-sm text-muted">
                {t("graph.node.nothingConnectsBody", { name: node.label })}
              </p>
            </div>
          ) : (
            <div className="space-y-7">
              {ordered.map(([label, es]) => (
                <section key={label} aria-label={label}>
                  <h3 className="mb-2 flex items-baseline gap-2 text-[15px] font-medium">
                    {label} <span className="text-sm font-normal tabular-nums text-muted">{es.length}</span>
                  </h3>
                  <ul className="divide-y divide-line/70 rounded-lg bg-surface">
                    {es.map((e) => (
                      <FactRow key={e.id} edge={{ id: e.id, relation: e.relation, status: e.status, confidence: e.confidence }}
                        from={end(byId.get(e.fromId)!)} to={end(byId.get(e.toId)!)} subjectId={node.id} label={label.toLowerCase()}
                        provenance={d.provenance.edges[e.id] ?? []} agents={d.agents}
                        canEdit={d.canEdit || e.ownerId === v.id} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-6 lg:sticky lg:top-8 lg:self-start">
          <ProvenancePanel items={d.provenance.node} agents={d.agents} title={t("graph.node.whereFrom", { name: node.label })}
            className="rounded-lg bg-surface p-5" emptyText={t("graph.node.noRecords")} t={t} locale={locale} />
          <WhoSaid name={node.label} items={allProvenance} agents={d.agents} t={t} locale={locale} className="px-1" />
          <HistoryPanel v={v} subjectId={node.id} name={node.label} className="px-1" />
          {memoryAllowed(v) && <MemoryPanel title={t("graph.node.memory")} aboutNodeId={node.id} aboutName={node.type === "person" ? node.label.split(" ")[0] : node.label} />}
          {d.mergeSuggestions.length > 0 && (
            <MergeSuggestions nodeId={node.id} nodeLabel={node.label}
              suggestions={d.mergeSuggestions.map((s) => ({ other: { id: s.other.id, type: s.other.type, label: s.other.label, summary: s.other.summary }, reason: s.reason, score: s.score }))} />
          )}
        </aside>
      </div>
    </article>
  );
}

/** Facts that need a decision first, then confirmed, then the ones marked wrong. */
function rank(status: string): number {
  return status === "inferred" || status === "unconfirmed" ? 0 : status === "confirmed" ? 1 : 2;
}

function peopleFirst(es: readonly GEdge[], other: (e: GEdge) => GNode): number {
  return es.some((e) => other(e).type === "person") ? 0 : 1;
}
