"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "@/lib/i18n/client";
import { recordingsAvailable } from "./nav-recordings";
import {
  BookOpen, Brain, Mic, Scale, CalendarRange, FolderOpen, GitPullRequestArrow, History, House, Layers, MessageCircle, MoreHorizontal, Network, Settings, Shapes, ShieldCheck, Stethoscope, Users, Workflow, X, type LucideIcon,
} from "lucide-react";

/**
 * `key` is the label under shell.nav.* (or `label`, a full message key, for items whose copy lives in their own
 * namespace). `text` is copy already translated on the server (the admin item, kept out of the client dictionary).
 */
type NavItem = { href: string; key: string; icon: LucideIcon; hideFor?: string[]; label?: string; text?: string };

/**
 * The platform admin console, for platform admins only. The shell passes `adminLabel` (translated on the server with
 * getAdminT) only when isPlatformAdmin(viewer); everyone else never gets the item or its name.
 */
function withAdmin(items: NavItem[], adminLabel?: string): NavItem[] {
  return adminLabel ? [...items, { href: "/admin", key: "admin", icon: ShieldCheck, text: adminLabel }] : items;
}

/** The clinical workspace, for accounts whose plan includes a practice add-on (the shell decides, on the server). */
function withPractice(items: NavItem[], practice?: boolean): NavItem[] {
  return practice ? [{ href: "/clinical", key: "clinical", icon: Stethoscope, label: "clinical.nav" }, ...items] : items;
}

/** Recordings (meetings from Record), once this graph has any recording or the person has connected Record. */
function withRecordings(items: NavItem[], recordings: boolean): NavItem[] {
  if (!recordings) return items;
  const at = items.findIndex((l) => l.href === "/library");
  const item: NavItem = { href: "/recordings", key: "recordings", icon: Mic, label: "recordings.title" };
  return at < 0 ? [...items, item] : [...items.slice(0, at + 1), item, ...items.slice(at + 1)];
}

const g = globalThis as unknown as { __mgNavRecordings?: { at: number; p: Promise<boolean> } };

/**
 * Whether to show Recordings. The shell may decide on the server (`recordings` prop); otherwise it is asked once per
 * page load, after the first paint, and the item appears when there is something to open.
 */
function useRecordings(given?: boolean): boolean {
  const [has, setHas] = useState(given ?? false);
  useEffect(() => {
    if (given !== undefined) { setHas(given); return; }
    let live = true;
    const json = (u: string) => fetch(u, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // Shared by the desktop and phone navigation; asked again after a minute (another graph may be open by then).
    if (!g.__mgNavRecordings || Date.now() - g.__mgNavRecordings.at > 60_000) {
      g.__mgNavRecordings = { at: Date.now(), p: Promise.all([json("/api/recordings?limit=1"), json("/api/connections")]).then(([r, c]) => recordingsAvailable(r, c)) };
    }
    void g.__mgNavRecordings.p.then((x) => { if (live) setHas(x); });
    return () => { live = false; };
  }, [given]);
  return has;
}

const PRIMARY: NavItem[] = [
  { href: "/", key: "today", icon: House },
  { href: "/chat", key: "ask", icon: MessageCircle },
  { href: "/people", key: "people", icon: Users },
  { href: "/timeline", key: "timeline", icon: CalendarRange },
];
const SECONDARY: NavItem[] = [
  { href: "/library", key: "library", icon: FolderOpen },
  { href: "/artifacts", key: "artifacts", icon: Shapes, hideFor: ["guest"], label: "artifacts.nav" },
  { href: "/rules", key: "corpora", icon: Scale, hideFor: ["guest", "child"], label: "corpus.nav" },
  { href: "/graph", key: "connections", icon: Network },
  { href: "/changes", key: "changes", icon: GitPullRequestArrow, hideFor: ["guest"], label: "changes.nav" },
  { href: "/history", key: "history", icon: History, hideFor: ["guest"], label: "history.nav" },
  { href: "/memory", key: "memory", icon: Brain, hideFor: ["guest", "child"] },
  { href: "/automations", key: "automations", icon: Workflow, hideFor: ["guest", "child"] },
  { href: "/graphs", key: "graphs", icon: Layers },
  { href: "/settings", key: "settings", icon: Settings },
  { href: "/docs", key: "docs", icon: BookOpen, label: "docs.nav" },
];

const visible = (role: string) => (l: NavItem) => !l.hideFor?.includes(role);
const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

export function NavLinks({ role, adminLabel, practice, recordings }: { role: string; adminLabel?: string; practice?: boolean; recordings?: boolean }) {
  const path = usePathname();
  const t = useT();
  const rec = useRecordings(recordings);
  const item = (l: NavItem) => {
    const active = isActive(path, l.href);
    const Icon = l.icon;
    return (
      <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
        className={clsx("relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[15px] transition-colors",
          active ? "font-medium text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg")}>
        {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-md bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06)]" />}
        <Icon className="relative size-[18px] shrink-0" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
        <span className="relative">{l.text ?? t(l.label ?? `shell.nav.${l.key}`)}</span>
      </Link>
    );
  };
  return (
    <nav aria-label={t("shell.nav.main")} className="flex flex-col gap-0.5 px-1">
      {PRIMARY.filter(visible(role)).map(item)}
      <div className="my-2" />
      {withAdmin(withPractice(withRecordings(SECONDARY.filter(visible(role)), rec), practice), adminLabel).map(item)}
    </nav>
  );
}

/** Phone navigation: four destinations and a More sheet. */
export function MobileNav({ role, adminLabel, practice, recordings }: { role: string; adminLabel?: string; practice?: boolean; recordings?: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const t = useT();
  const rec = useRecordings(recordings);
  const more = withAdmin(withPractice(withRecordings(SECONDARY.filter(visible(role)), rec), practice), adminLabel);
  const moreActive = more.some((l) => isActive(path, l.href));
  return (
    <>
      <nav aria-label={t("shell.nav.main")} className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_var(--line)] backdrop-blur lg:hidden">
        {PRIMARY.map((l) => {
          const active = isActive(path, l.href);
          const Icon = l.icon;
          return (
            <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
              className={clsx("flex flex-col items-center gap-0.5 py-2 text-[11px]", active ? "font-medium text-fg" : "text-muted")}>
              <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} aria-hidden />{t(l.label ?? `shell.nav.${l.key}`)}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open}
          className={clsx("flex flex-col items-center gap-0.5 py-2 text-[11px]", moreActive ? "font-medium text-fg" : "text-muted")}>
          <MoreHorizontal className="size-5" aria-hidden />{t("shell.nav.more")}
        </button>
      </nav>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="fixed inset-0 z-50 bg-fg/30 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.div role="dialog" aria-label={t("shell.nav.more")} className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-float lg:hidden"
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
              <div className="mb-1 flex items-center justify-between px-2">
                <span className="font-semibold">{t("shell.nav.more")}</span>
                <button type="button" aria-label={t("shell.nav.close")} onClick={() => setOpen(false)} className="rounded-md p-2 text-muted hover:bg-surface-2"><X className="size-5" /></button>
              </div>
              {more.map((l) => {
                const Icon = l.icon;
                return (
                  <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
                    className={clsx("flex items-center gap-3 rounded-md px-3 py-3", isActive(path, l.href) ? "bg-surface-2 font-medium" : "")}>
                    <Icon className="size-5 text-muted" aria-hidden />{l.text ?? t(l.label ?? `shell.nav.${l.key}`)}
                  </Link>
                );
              })}
              <form action="/api/auth/logout" method="post">
                <button className="mt-1 w-full rounded-md px-3 py-3 text-left text-muted hover:bg-surface-2">{t("shell.signOut")}</button>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
