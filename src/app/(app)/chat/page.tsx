import type { Metadata } from "next";
import { isParent, requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/assistant/store";
import { muxHealth } from "@/lib/mux";
import { ChatApp } from "@/components/chat/chat-app";
import { familyStarters } from "./family";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ask · My Graph" };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const v = await requireUser();
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 4000) || null;
  const [conversations, health, starters] = await Promise.all([listConversations(v), muxHealth(), familyStarters(v)]);
  return (
    <ChatApp
      key="new"
      conversations={conversations}
      conversation={null}
      mux={{ ok: health.ok, reachable: health.reachable, configured: health.configured }}
      canFix={isParent(v)}
      starters={starters}
      initialQuestion={q}
    />
  );
}
