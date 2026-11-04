import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { listMembers } from "@/lib/graphs";
import { loadGraphViews } from "@/components/graphs/data";
import { GraphsManager, type SelectedDetail } from "@/components/graphs/graphs-manager";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("graphs.page.metaTitle")} · My Graph` };
}
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function GraphsPage({ searchParams }: { searchParams: Promise<{ g?: string; new?: string; invite?: string }> }) {
  const v = await requireUser();
  const sp = await searchParams;
  const graphs = await loadGraphViews(v);
  const creating = sp.new === "1";
  const requested = typeof sp.g === "string" && UUID.test(sp.g) ? sp.g : null;
  const selected = creating ? null : graphs.find((g) => g.id === requested) ?? graphs.find((g) => g.isCurrent) ?? graphs[0] ?? null;

  let detail: SelectedDetail | null = null;
  if (selected) {
    const { members, invites } = await listMembers(v, selected.id);
    detail = {
      id: selected.id,
      members: members.map((m) => ({
        userId: m.userId, name: m.name, email: m.email, role: m.role, isYou: m.isYou, addedAt: m.addedAt,
        colorId: selected.members.find((p) => p.userId === m.userId)?.colorId ?? m.userId,
      })),
      invites: invites.filter((i) => i.state === "open").map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt })),
    };
  }

  return (
    <GraphsManager
      graphs={graphs}
      youId={v.id}
      canCreate={v.role !== "guest"}
      creating={creating}
      explicit={!!requested || creating}
      selectedId={selected?.id ?? null}
      detail={detail}
      focusInvite={sp.invite === "1"}
    />
  );
}
