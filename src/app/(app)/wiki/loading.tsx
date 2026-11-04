export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the wiki…</span>
      <div className="mb-3 h-8 w-28 animate-pulse rounded-md bg-surface-2" />
      <div className="mb-8 h-4 w-full max-w-lg animate-pulse rounded bg-surface-2" />
      <div className="mb-8 h-10 max-w-xl animate-pulse rounded-md bg-surface-2" />
      <div className="max-w-[760px] space-y-6">
        {[80, 64, 72, 56].map((w, i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 animate-pulse rounded bg-surface-2" style={{ width: `${w * 0.5}%` }} />
            <div className="h-3.5 animate-pulse rounded bg-surface-2/70" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
