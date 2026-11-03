import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NodeNotFound() {
  return (
    <EmptyState title="We couldn't find that">
      It may have been removed, or it hasn&rsquo;t been shared with you.{" "}
      <Link href="/graph" className="text-accent hover:underline">Back to the graph</Link>
    </EmptyState>
  );
}
