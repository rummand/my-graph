import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ConnectionError, connectorById, connectorInfo, getConnection, listConnections, offeredIn } from "@/lib/connectors";
import { isPlatformAdmin } from "@/lib/plans";
import * as gbrain from "@/lib/gbrain";
import { getT } from "@/lib/i18n";
import { ConnectionDetail } from "@/components/connections/connection-detail";
import { ConnectionsPageActions } from "@/components/connections/assistant-actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("connections.metaTitle") };
}

/** One of my connections in this graph: status, run log and settings. Anyone else's (or another graph's) is a 404. */
export default async function ConnectionPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const detail = await getConnection(v, id).catch((e) => {
    if (e instanceof ConnectionError && e.status === 404) return null;
    throw e;
  });
  if (!detail) notFound();
  const c = connectorById(detail.connection.connector);
  const [people, mine] = await Promise.all([
    gbrain.listNodes(v, { type: "person", limit: 200 }).catch(() => []),
    listConnections(v).catch(() => []),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <ConnectionsPageActions connectors={offeredIn(v.graphKind, isPlatformAdmin(v)).map(connectorInfo)} connections={mine} />
      <ConnectionDetail initial={detail.connection} runs={detail.runs} info={c ? connectorInfo(c) : null}
        people={people.map((p) => ({ id: p.id, label: p.label })).sort((a, b) => a.label.localeCompare(b.label))}
        family={v.graphKind === "family"} />
    </div>
  );
}
