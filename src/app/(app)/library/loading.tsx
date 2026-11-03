export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the library…</span>
      <div className="mb-6 h-8 w-40 animate-pulse rounded bg-surface-2" />
      <div className="h-48 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-6 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-56 animate-pulse rounded-lg bg-surface-2" />)}
      </div>
    </div>
  );
}
