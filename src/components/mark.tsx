/**
 * The My Graph mark: a small graph (three nodes, two links) in a rounded square, drawn once here. Black and white,
 * following the theme (dark square with light lines; light square with dark lines in dark mode). Safe to import from
 * client and server components. The app icons (src/app/icon.svg, the iOS AppIcon) use the same drawing.
 */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <rect width="28" height="28" rx="8" className="fill-fg" />
      <g transform="translate(5.5 5.5) scale(0.7083)" fill="none" className="stroke-bg" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" />
      </g>
    </svg>
  );
}
