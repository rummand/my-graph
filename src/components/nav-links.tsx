"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

const LINKS = [
  { href: "/", label: "Today" },
  { href: "/chat", label: "Ask" },
  { href: "/timeline", label: "Timeline" },
  { href: "/library", label: "Library" },
  { href: "/wiki", label: "Wiki" },
  { href: "/graph", label: "Graph" },
  { href: "/settings", label: "Family & settings" },
];

export function NavLinks({ role }: { role: string }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href}
            className={clsx("whitespace-nowrap rounded-md px-3 py-2 text-sm", active ? "bg-accent-tint font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>
            {l.label}
          </Link>
        );
      })}
      <form action="/api/auth/logout" method="post" className="md:mt-4">
        <button className="whitespace-nowrap rounded-md px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg">Sign out</button>
      </form>
    </nav>
  );
}
