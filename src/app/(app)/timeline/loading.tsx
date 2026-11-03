import { TimelineSkeleton } from "@/components/timeline/timeline-view";

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 h-8 w-40 animate-pulse rounded bg-surface-2" />
      <TimelineSkeleton />
    </div>
  );
}
