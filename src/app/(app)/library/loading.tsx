/** The library's own layout with flat placeholders, so nothing jumps when the files arrive. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the library…</span>
      <div className="mb-8">
        <div className="h-8 w-32 rounded-md bg-surface-2" />
        <div className="mt-3 h-5 w-[min(32rem,100%)] rounded bg-surface-2" />
      </div>
      <div className="h-44 rounded-lg bg-surface" />
      <div className="mb-4 mt-10 h-6 w-28 rounded bg-surface-2" />
      <div className="mb-5 h-9 w-full rounded-md bg-surface-2 lg:w-72" />
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i}>
            <div className="aspect-[4/3] rounded-lg bg-surface-2" />
            <div className="mt-2 h-4 w-3/4 rounded bg-surface-2" />
            <div className="mt-1.5 h-3 w-1/3 rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
