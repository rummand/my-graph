import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NodeNotFound() {
  return (
    <EmptyState title="We couldn't find that"
      action={<Link href="/graph" className="text-sm text-accent hover:underline">Back to the graph</Link>}>
      It may have been merged into something else or removed, or it hasn&rsquo;t been shared with you.
    </EmptyState>
  );
}
