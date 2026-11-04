import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isParent, requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { annotateMessages, memoryAllowedFor } from "@/lib/assistant/apply";
import { getConversation, listConversations, markRead } from "@/lib/assistant/store";
import { muxHealth } from "@/lib/mux";
import { ChatApp } from "@/components/chat/chat-app";
import { graphStarters } from "../starters";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("chat.pageTitle")} · My Graph` };
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await requireUser();
  const t = await getT();
  // Opening a conversation reads it.
  await markRead(v, id);
  const [conversation, conversations, health, starters] = await Promise.all([getConversation(v, id), listConversations(v), muxHealth(), graphStarters(v, t)]);
  if (!conversation) notFound();
  if (!memoryAllowedFor(v)) for (const m of conversation.messages) m.proposals = m.proposals.filter((p) => p.type !== "propose_memory");
  await annotateMessages(v, conversation.messages, conversation.sensitivity);
  return (
    <ChatApp
      key={conversation.id}
      conversations={conversations}
      conversation={conversation}
      mux={{ ok: health.ok, reachable: health.reachable, configured: health.configured }}
      canFix={isParent(v)}
      starters={starters}
      graphKind={v.graphKind}
    />
  );
}
