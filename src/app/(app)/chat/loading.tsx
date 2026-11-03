export default function ChatLoading() {
  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-[240px_minmax(0,1fr)]" aria-busy="true" aria-label="Loading conversations">
      <div className="hidden space-y-2 md:block">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded-md bg-surface-2" />)}
      </div>
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-md bg-surface-2" />
        <div className="h-24 animate-pulse rounded-lg bg-surface-2" />
        <div className="h-24 animate-pulse rounded-lg bg-surface-2" />
      </div>
    </div>
  );
}
