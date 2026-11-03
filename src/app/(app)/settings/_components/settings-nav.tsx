"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

export function SettingsNav({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Settings sections" className="-mx-4 mt-4 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0">
      <ul className="flex gap-1">
        {tabs.map((t) => {
          const active = t.href === "/settings" ? path === "/settings" : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={clsx("-mb-px block whitespace-nowrap border-b-2 px-3 py-2 text-sm",
                  active ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-fg")}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
