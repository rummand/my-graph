export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the wiki…</span>
      <div className="mb-3 h-8 w-32 animate-pulse rounded bg-surface-2" />
      <div className="mb-8 h-4 w-full max-w-xl animate-pulse rounded bg-surface-2" />
      <div className="space-y-4">
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="h-12 max-w-[70ch] animate-pulse rounded bg-surface-2" />)}
      </div>
    </div>
  );
}
