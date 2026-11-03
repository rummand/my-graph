import type { Metadata } from "next";
import { isParent, requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/assistant/store";
import { muxHealth } from "@/lib/mux";
import { ChatApp } from "@/components/chat/chat-app";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ask · My Graph" };

export default async function ChatPage() {
  const v = await requireUser();
  const [conversations, health] = await Promise.all([listConversations(v), muxHealth()]);
  return (
    <ChatApp
      key="new"
      conversations={conversations}
      conversation={null}
      mux={{ ok: health.ok, reachable: health.reachable, configured: health.configured }}
      canFix={isParent(v)}
    />
  );
}
