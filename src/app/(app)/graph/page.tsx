import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { graph, isUuid } from "@/lib/gbrain";
import { getMeta } from "@/lib/meta";
import { scopeOf } from "@/lib/graphs/pure";
import { getT } from "@/lib/i18n";
import { GraphExplorer, type GraphData } from "@/components/graph";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("graph.metaTitle")} · My Graph` };
}
export const dynamic = "force-dynamic";

const LIMIT = 300;

export default async function GraphPage({ searchParams }: { searchParams: Promise<{ center?: string | string[] }> }) {
  const v = await requireUser();
  const raw = (await searchParams).center;
  const center = typeof raw === "string" && isUuid(raw) ? raw : null;
  const [g, meta, t] = await Promise.all([graph(v, { limit: LIMIT, centerId: center ?? undefined }), getMeta(v), getT()]);
  const data: GraphData = {
    nodes: g.nodes.map((n) => ({
      id: n.id, type: n.type, label: n.label, summary: n.summary, aliases: n.aliases,
      kindLabel: meta.kind(n.type, n.kind)?.label ?? null,
    })),
    edges: g.edges.map((e) => ({
      id: e.id, from: e.fromId, to: e.toId, relation: e.relation, status: e.status, confidence: e.confidence,
      label: meta.relationLabel(e.relation, "out"), inverseLabel: meta.relationLabel(e.relation, "in"),
    })),
  };
  const centerLabel = center ? g.nodes.find((n) => n.id === center)?.label : null;
  return (
    <>
      <header className="mb-5">
        <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{centerLabel ? t("graph.around", { name: centerLabel }) : t("graph.title")}</h1>
        <p className="mt-1.5 max-w-[60ch] text-muted">
          {centerLabel
            ? t("graph.aroundLead", { name: centerLabel })
            : scopeOf(v).family ? t("graph.leadFamily") : t("graph.lead", { graph: v.graphName })}
        </p>
      </header>
      <GraphExplorer data={data} centerId={center} truncated={!center && g.nodes.length >= LIMIT} />
    </>
  );
}
