/**
 * The Artifacts hub's header: the title, the tab's lead, the New menu and the tabs (All, Pages, Documents, Decks,
 * Styles). Server component; kinds, labels and routes come from the registry in src/lib/artifacts/kinds.ts.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import type { Viewer } from "@/lib/auth";
import { canMakeArtifacts } from "@/lib/artifacts";
import { availableKinds, type MadeKind } from "@/lib/artifacts/kinds";
import { scopeOf } from "@/lib/graphs/pure";
import type { TFn } from "@/lib/i18n";
import { NewMenu, type NewMenuItem } from "./new-menu";

export type HubTab = "all" | MadeKind | "styles";

/** Who may start each kind: pages need write access and not a guest; documents and decks need canMakeArtifacts. */
export function canStart(v: Viewer, kind: MadeKind): boolean {
  if (kind === "page") return v.role !== "guest" && scopeOf(v).canWrite;
  return canMakeArtifacts(v);
}

export function newMenuItems(v: Viewer, t: TFn): NewMenuItem[] {
  return availableKinds().filter((k) => canStart(v, k.id)).map((k) => ({ id: k.id, href: k.newHref, label: t(k.label), hint: t(k.hint), icon: k.icon }));
}

export function ArtifactsHubHeader({ v, t, active, lead, actions }: { v: Viewer; t: TFn; active: HubTab; lead?: ReactNode; actions?: ReactNode }) {
  const tabs: { id: HubTab; href: string; label: string }[] = [
    { id: "all", href: "/artifacts", label: t("artifacts.hub.tabs.all") },
    ...availableKinds().map((k) => ({ id: k.id as HubTab, href: k.route, label: t(k.plural) })),
    { id: "styles", href: "/artifacts/styles", label: t("artifacts.hub.tabs.styles") },
  ];
  return (
    <div className="mb-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("artifacts.hub.title")}</h1>
          {lead && <p className="mt-2 max-w-[62ch] text-muted">{lead}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <NewMenu items={newMenuItems(v, t)} />
        </div>
      </header>
      <nav aria-label={t("artifacts.hub.tabsLabel")} className="-mx-1 overflow-x-auto">
        <ul className="inline-flex min-w-max gap-0.5 rounded-md bg-surface-2 p-0.5">
          {tabs.map((tab) => {
            const on = tab.id === active;
            return (
              <li key={tab.id}>
                <Link href={tab.href} aria-current={on ? "page" : undefined}
                  className={clsx("inline-flex h-8 items-center rounded-[5px] px-3 text-sm transition-colors",
                    on ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-fg")}>
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
