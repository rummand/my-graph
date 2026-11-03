"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { ArrowUpRight, KeyRound, ScrollText, Shapes, UserRound, UsersRound } from "lucide-react";

const ICONS = { profile: UserRound, security: KeyRound, family: UsersRound, audit: ScrollText, model: Shapes } as const;
export type SettingsTab = { href: string; label: string; icon: keyof typeof ICONS; external?: boolean };

/** Section list for settings: a column beside the page on wide screens, a scrolling row of pills on phones. */
export function SettingsNav({ tabs }: { tabs: SettingsTab[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Settings sections" className="mb-6 lg:sticky lg:top-9 lg:mb-0 lg:self-start">
      <p className="mb-2 hidden px-2.5 text-sm font-semibold lg:block">Family &amp; settings</p>
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0">
        {tabs.map((t) => {
          const active = !t.external && (t.href === "/settings" ? path === "/settings" : path.startsWith(t.href));
          const Icon = ICONS[t.icon];
          return (
            <li key={t.href} className={clsx(t.external && "lg:mt-3")}>
              <Link href={t.href} aria-current={active ? "page" : undefined}
                className={clsx("flex h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-sm transition-colors",
                  active ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
                <span className="flex-1">{t.label}</span>
                {t.external && <ArrowUpRight size={14} aria-hidden className="shrink-0 opacity-60" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
