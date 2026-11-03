import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { graph, isUuid } from "@/lib/gbrain";
import { PageHeader } from "@/components/ui";
import { GraphExplorer, type GraphData } from "@/components/graph";

export const metadata: Metadata = { title: "Graph · My Graph" };
export const dynamic = "force-dynamic";

const LIMIT = 300;

export default async function GraphPage({ searchParams }: { searchParams: Promise<{ center?: string | string[] }> }) {
  const v = await requireUser();
  const raw = (await searchParams).center;
  const center = typeof raw === "string" && isUuid(raw) ? raw : null;
  const g = await graph(v, { limit: LIMIT, centerId: center ?? undefined });
  const data: GraphData = {
    nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, summary: n.summary, aliases: n.aliases })),
    edges: g.edges.map((e) => ({ id: e.id, from: e.fromId, to: e.toId, relation: e.relation, status: e.status, confidence: e.confidence })),
  };
  const centerLabel = center ? g.nodes.find((n) => n.id === center)?.label : null;
  return (
    <>
      <PageHeader
        title={centerLabel ? `Around ${centerLabel}` : "Graph"}
        lead={centerLabel
          ? "Everything within two steps. Dashed lines are the assistant's guesses; faint lines aren't confirmed yet."
          : "Everyone and everything in your brain and how they connect. Dashed lines are the assistant's guesses; faint lines aren't confirmed yet."}
      />
      <GraphExplorer data={data} centerId={center} truncated={!center && g.nodes.length >= LIMIT} />
    </>
  );
}
