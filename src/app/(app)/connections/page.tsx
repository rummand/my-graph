import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { connectorInfo, listConnections, offeredIn } from "@/lib/connectors";
import * as gbrain from "@/lib/gbrain";
import { getT } from "@/lib/i18n";
import { PageHeader } from "@/components/ui";
import { ConnectionsApp } from "@/components/connections/connections-app";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("connections.metaTitle") };
}

/**
 * Connections: calendar links and mailboxes that bring outside content into the current graph, as the signed-in
 * person. Only their own connections in this graph are listed. Aula calendar and Aula messages appear only in a
 * family graph; Aula messages is shown as coming soon.
 */
export default async function ConnectionsPage() {
  const v = await requireUser();
  const t = await getT();
  const [connections, people] = await Promise.all([
    listConnections(v),
    gbrain.listNodes(v, { type: "person", limit: 200 }).catch(() => []),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("connections.title")} lead={t("connections.lead", { graph: v.graphName })} />
      <ConnectionsApp initial={connections} connectors={offeredIn(v.graphKind).map(connectorInfo)}
        people={people.map((p) => ({ id: p.id, label: p.label })).sort((a, b) => a.label.localeCompare(b.label))}
        family={v.graphKind === "family"} graphName={v.graphName} />
    </div>
  );
}
