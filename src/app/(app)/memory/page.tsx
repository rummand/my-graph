import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { canAddMemory, listMemories, memoryAllowed, memoryPeople, viewMemories } from "@/lib/memory";
import { MemoryBoard } from "@/components/memory/memory-board";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("memory.metaTitle") };
}

export default async function MemoryPage() {
  const v = await requireUser();
  // Children and guests don't see Memory at all (the link is hidden for them too).
  if (!memoryAllowed(v)) notFound();
  const [list, people] = await Promise.all([listMemories(v, { status: "all" }), memoryPeople(v)]);
  const initial = await viewMemories(v, list);
  return <MemoryBoard initial={initial} people={people} canAdd={canAddMemory(v)} graphKind={v.graphKind} graphName={v.graphName} />;
}
