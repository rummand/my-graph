import { TimelineSkeleton } from "@/components/timeline/timeline-view";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1360px]">
      <div className="mb-8">
        <div className="h-8 w-36 animate-pulse rounded-md bg-surface-2" />
        <div className="mt-3 h-5 w-96 max-w-full animate-pulse rounded-md bg-surface-2" />
      </div>
      <TimelineSkeleton />
    </div>
  );
}
