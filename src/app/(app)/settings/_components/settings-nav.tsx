"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  ArrowUpRight, BadgeCheck, Bot, Cable, Database, Globe, KeyRound, Layers, Palette, Plug, ScrollText, Shapes, ShieldCheck, UserRound, UsersRound,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";

const ICONS = {
  profile: UserRound, language: Globe, appearance: Palette, security: KeyRound, graph: Layers, household: UsersRound,
  assistant: Bot, connections: Plug, data: Database, family: UsersRound, audit: ScrollText, model: Shapes,
  plan: BadgeCheck, admin: ShieldCheck, aiApps: Cable,
} as const;
/**
 * `key` names the label (settings.nav.<key>) and the icon. `anchor` items are sections of /settings. `label`
 * overrides the message (for copy the server translates and keeps out of the client dictionary).
 */
export type SettingsTab = { href: string; key: keyof typeof ICONS; anchor?: boolean; external?: boolean; label?: string };

/**
 * Sections of the settings page, then the pages under it. A column beside the page on wide screens (it follows the
 * section you are reading), a scrolling row of pills on phones.
 */
export function SettingsNav({ tabs }: { tabs: SettingsTab[] }) {
  const path = usePathname();
  const t = useT();
  const [spy, setSpy] = useState<string | null>(null);
  const onMain = path === "/settings";

  useEffect(() => {
    if (!onMain) { setSpy(null); return; }
    const ids = tabs.filter((x) => x.anchor).map((x) => x.href.split("#")[1]);
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setSpy(top.target.id);
    }, { rootMargin: "-10% 0px -70% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [onMain, tabs]);

  const main = tabs.filter((x) => x.anchor);
  const pages = tabs.filter((x) => !x.anchor);
  const item = (x: SettingsTab) => {
    const id = x.href.split("#")[1];
    const active = x.anchor ? onMain && (spy ?? main[0]?.href.split("#")[1]) === id : !x.external && path.startsWith(x.href);
    const Icon = ICONS[x.key];
    return (
      <li key={x.href}>
        <Link href={x.href} aria-current={active ? (x.anchor ? "location" : "page") : undefined}
          className={clsx("flex h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-sm transition-colors",
            active ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
          <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="flex-1">{x.label ?? t(`settings.nav.${x.key}`)}</span>
          {x.external && <ArrowUpRight size={14} aria-hidden className="shrink-0 opacity-60" />}
        </Link>
      </li>
    );
  };
  return (
    <nav aria-label={t("settings.nav.label")} className="mb-6 lg:sticky lg:top-9 lg:mb-0 lg:self-start">
      <p className="mb-2 hidden px-2.5 text-sm font-semibold lg:block">{t("settings.nav.heading")}</p>
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0">
        {main.map(item)}
        {pages.length > 0 && <li aria-hidden className="hidden lg:block lg:h-3" />}
        {pages.map(item)}
      </ul>
    </nav>
  );
}
