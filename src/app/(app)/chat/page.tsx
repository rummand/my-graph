import type { Metadata } from "next";
import { isParent, requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { listConversations } from "@/lib/assistant/store";
import { muxHealth } from "@/lib/mux";
import { ChatApp } from "@/components/chat/chat-app";
import { graphStarters } from "./starters";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("chat.pageTitle")} · My Graph` };
}

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const v = await requireUser();
  const t = await getT();
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 4000) || null;
  const [conversations, health, starters] = await Promise.all([listConversations(v), muxHealth(), graphStarters(v, t)]);
  return (
    <ChatApp
      key="new"
      conversations={conversations}
      conversation={null}
      mux={{ ok: health.ok, reachable: health.reachable, configured: health.configured }}
      canFix={isParent(v)}
      starters={starters}
      graphKind={v.graphKind}
      initialQuestion={q}
    />
  );
}
