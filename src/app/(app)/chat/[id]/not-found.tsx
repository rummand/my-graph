import Link from "next/link";
import { EmptyState, buttonClass } from "@/components/ui";

export default function ConversationNotFound() {
  return (
    <div className="mx-auto max-w-xl py-16">
      <EmptyState title="That conversation isn't here"
        action={<Link href="/chat" className={buttonClass("primary")}>Start a new conversation</Link>}>
        <p>It may have been deleted, or it was started by someone else in the family. Conversations are private to the person who asked.</p>
      </EmptyState>
    </div>
  );
}
