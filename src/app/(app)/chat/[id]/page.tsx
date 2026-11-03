import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isParent, requireUser } from "@/lib/auth";
import { getConversation, listConversations } from "@/lib/assistant/store";
import { muxHealth } from "@/lib/mux";
import { ChatApp } from "@/components/chat/chat-app";
import { familyStarters } from "../family";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ask · My Graph" };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await requireUser();
  const [conversation, conversations, health, starters] = await Promise.all([getConversation(v, id), listConversations(v), muxHealth(), familyStarters(v)]);
  if (!conversation) notFound();
  return (
    <ChatApp
      key={conversation.id}
      conversations={conversations}
      conversation={conversation}
      mux={{ ok: health.ok, reachable: health.reachable, configured: health.configured }}
      canFix={isParent(v)}
      starters={starters}
    />
  );
}
