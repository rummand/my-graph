export default function ChatLoading() {
  return (
    <div className="lg:grid lg:grid-cols-[216px_minmax(0,1fr)] lg:gap-10" aria-busy="true" aria-label="Loading conversations">
      <div className="hidden space-y-2 lg:block">
        <div className="mb-6 h-9 w-40 rounded-md bg-surface-2/70" />
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-8 rounded-md bg-surface-2/70" style={{ width: `${88 - i * 7}%` }} />)}
      </div>
      <div className="mx-auto w-full max-w-[680px] space-y-4 pt-16">
        <div className="h-7 w-2/3 rounded-md bg-surface-2/70" />
        <div className="h-4 w-full rounded bg-surface-2/70" />
        <div className="h-4 w-11/12 rounded bg-surface-2/70" />
        <div className="h-4 w-3/4 rounded bg-surface-2/70" />
      </div>
    </div>
  );
}
