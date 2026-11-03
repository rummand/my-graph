import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl">
      <EmptyState title="Page not found">
        <p>It may have been deleted, or it hasn&apos;t been shared with you.</p>
        <Link href="/wiki" className="mt-3 inline-block text-accent hover:underline">Back to the wiki</Link>
      </EmptyState>
    </div>
  );
}
