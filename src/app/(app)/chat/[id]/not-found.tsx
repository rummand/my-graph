import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function ConversationNotFound() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <EmptyState title="We couldn't find that conversation">
        <p>It may have been deleted, or it belongs to someone else.</p>
        <p className="mt-3"><Link href="/chat" className="text-accent underline-offset-2 hover:underline">Start a new conversation</Link></p>
      </EmptyState>
    </div>
  );
}
