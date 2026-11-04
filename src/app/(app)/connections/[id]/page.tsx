import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ConnectionError, connectorById, connectorInfo, getConnection } from "@/lib/connectors";
import * as gbrain from "@/lib/gbrain";
import { getT } from "@/lib/i18n";
import { ConnectionDetail } from "@/components/connections/connection-detail";

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
  const people = await gbrain.listNodes(v, { type: "person", limit: 200 }).catch(() => []);
  return (
    <div className="mx-auto max-w-3xl">
      <ConnectionDetail initial={detail.connection} runs={detail.runs} info={c ? connectorInfo(c) : null}
        people={people.map((p) => ({ id: p.id, label: p.label })).sort((a, b) => a.label.localeCompare(b.label))}
        family={v.graphKind === "family"} />
    </div>
  );
}
