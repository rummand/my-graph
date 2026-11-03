/** The My Graph mark: three people joined, drawn once here. Safe to import from client and server components. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <rect width="28" height="28" rx="8" className="fill-fg" />
      <path d="M9 18.5 14 9l5 9.5" fill="none" className="stroke-bg" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="14" cy="9" r="2.6" className="fill-accent stroke-fg" strokeWidth="1.2" />
      <circle cx="9" cy="18.5" r="2.6" className="fill-bg" />
      <circle cx="19" cy="18.5" r="2.6" className="fill-bg" />
    </svg>
  );
}
