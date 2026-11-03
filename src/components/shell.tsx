import Link from "next/link";
import type { Viewer } from "@/lib/auth";
import { NavLinks } from "./nav-links";

export function Shell({ viewer, children }: { viewer: Viewer; children: React.ReactNode }) {
  return (
    <div className="min-h-full md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-surface md:min-h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-3 px-4 py-4 md:block">
          <Link href="/" className="text-lg font-semibold tracking-tight">My Graph</Link>
          <div className="text-xs text-muted md:mt-1">{viewer.name} · {viewer.role}</div>
        </div>
        <NavLinks role={viewer.role} />
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
