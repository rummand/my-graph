import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isParent, requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getActiveSession } from "@/lib/assistant/session";
import { muxHealth } from "@/lib/mux";
import { ChatApp } from "@/components/chat/chat-app";
import { graphStarters } from "./starters";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("chat.pageTitle") };
}

/**
 * /chat: the always-active session, full size. It opens on the active conversation (the same one the Ask panel, other
 * devices and the iOS app show); ?new=1 opens a new conversation, ?q= asks a question in a new one.
 */
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; new?: string }> }) {
  const v = await requireUser();
  const t = await getT();
  const sp = await searchParams;
  const raw = sp.q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 4000) || null;
  const fresh = sp.new === "1";
  const { conversationId, conversations } = await getActiveSession(v);
  if (conversationId && !q && !fresh) redirect(`/chat/${conversationId}`);
  const [health, starters] = await Promise.all([muxHealth(), graphStarters(v, t)]);
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
      startedNew={fresh}
    />
  );
}
