import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="max-w-3xl">
      <EmptyState title="This page isn't here">
        <p>It may have been deleted, it may live in another graph, or it hasn&apos;t been shared with you.</p>
        <Link href="/wiki" className="mt-3 inline-block font-medium text-accent hover:underline">Back to the wiki</Link>
      </EmptyState>
    </div>
  );
}
