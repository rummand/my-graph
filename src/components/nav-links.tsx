"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarRange, FileText, FolderOpen, House, Layers, MessageCircle, MoreHorizontal, Network, Settings, Users, X, type LucideIcon,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: LucideIcon; hideFor?: string[] };

const PRIMARY: NavItem[] = [
  { href: "/", label: "Today", icon: House },
  { href: "/chat", label: "Ask", icon: MessageCircle },
  { href: "/people", label: "People", icon: Users },
  { href: "/timeline", label: "Timeline", icon: CalendarRange },
];
const SECONDARY: NavItem[] = [
  { href: "/library", label: "Library", icon: FolderOpen },
  { href: "/wiki", label: "Wiki", icon: FileText, hideFor: ["guest"] },
  { href: "/graph", label: "Connections", icon: Network },
  { href: "/graphs", label: "Graphs", icon: Layers },
  { href: "/settings", label: "Family & settings", icon: Settings },
];

const visible = (role: string) => (l: NavItem) => !l.hideFor?.includes(role);
const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

export function NavLinks({ role }: { role: string }) {
  const path = usePathname();
  const item = (l: NavItem) => {
    const active = isActive(path, l.href);
    const Icon = l.icon;
    return (
      <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
        className={clsx("relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[15px] transition-colors",
          active ? "font-medium text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg")}>
        {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-md bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06)]" />}
        <Icon className="relative size-[18px] shrink-0" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
        <span className="relative">{l.label}</span>
      </Link>
    );
  };
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-1">
      {PRIMARY.filter(visible(role)).map(item)}
      <div className="my-2" />
      {SECONDARY.filter(visible(role)).map(item)}
    </nav>
  );
}

/** Phone navigation: four destinations and a More sheet. */
export function MobileNav({ role }: { role: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const more = SECONDARY.filter(visible(role));
  const moreActive = more.some((l) => isActive(path, l.href));
  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_var(--line)] backdrop-blur lg:hidden">
        {PRIMARY.map((l) => {
          const active = isActive(path, l.href);
          const Icon = l.icon;
          return (
            <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
              className={clsx("flex flex-col items-center gap-0.5 py-2 text-[11px]", active ? "font-medium text-fg" : "text-muted")}>
              <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} aria-hidden />{l.label}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open}
          className={clsx("flex flex-col items-center gap-0.5 py-2 text-[11px]", moreActive ? "font-medium text-fg" : "text-muted")}>
          <MoreHorizontal className="size-5" aria-hidden />More
        </button>
      </nav>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="fixed inset-0 z-50 bg-fg/30 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.div role="dialog" aria-label="More" className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-float lg:hidden"
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
              <div className="mb-1 flex items-center justify-between px-2">
                <span className="font-semibold">More</span>
                <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-md p-2 text-muted hover:bg-surface-2"><X className="size-5" /></button>
              </div>
              {more.map((l) => {
                const Icon = l.icon;
                return (
                  <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
                    className={clsx("flex items-center gap-3 rounded-md px-3 py-3", isActive(path, l.href) ? "bg-surface-2 font-medium" : "")}>
                    <Icon className="size-5 text-muted" aria-hidden />{l.label}
                  </Link>
                );
              })}
              <form action="/api/auth/logout" method="post">
                <button className="mt-1 w-full rounded-md px-3 py-3 text-left text-muted hover:bg-surface-2">Sign out</button>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
