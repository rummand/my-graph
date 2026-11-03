import type { ReactNode } from "react";

/** Centered frame for the signed-out pages (login, setup, waiting for approval). */
export function AuthFrame({ title, lead, children, footer }: { title: string; lead?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-full items-start justify-center px-4 py-10 sm:items-center sm:py-16">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-lg font-semibold tracking-tight text-accent">My Graph</p>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {lead && <div className="mt-1 text-sm text-muted">{lead}</div>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-xs text-muted">{footer}</div>}
      </div>
    </main>
  );
}
