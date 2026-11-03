import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl">
      <EmptyState title="File not found">
        <p>It may have been deleted, or it isn&apos;t shared with you.</p>
        <Link href="/library" className="mt-3 inline-block text-accent hover:underline">Back to the library</Link>
      </EmptyState>
    </div>
  );
}
