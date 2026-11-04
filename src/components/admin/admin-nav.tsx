"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

/** The console's sections as a row of tabs. Labels come translated from the server. */
export function AdminNav({ items, label }: { items: { href: string; label: string }[]; label: string }) {
  const path = usePathname();
  const active = (href: string) => (href === "/admin" ? path === "/admin" || path.startsWith("/admin/accounts") : path.startsWith(href));
  return (
    <nav aria-label={label} className="-mx-4 mb-8 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
      <ul className="inline-flex rounded-md bg-surface-2 p-0.5">
        {items.map((it) => (
          <li key={it.href}>
            <Link href={it.href} aria-current={active(it.href) ? "page" : undefined}
              className={clsx("inline-flex h-8 items-center whitespace-nowrap rounded-[5px] px-3 text-sm transition-colors",
                active(it.href) ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-fg")}>
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
