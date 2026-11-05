import Link from "next/link";
import type { Viewer } from "@/lib/auth";
import { Avatar } from "@/components/ui";
import { NavLinks, MobileNav } from "./nav-links";
import { AskBox } from "./ask-box";
import { SearchPalette } from "./search/palette";
import { SearchButton, SearchField } from "./search/search-trigger";
import { AssistantPanel } from "./assistant/panel";
import { MotionRoot } from "./motion-root";
import { Mark } from "./mark";
import { GraphSwitcher } from "./graphs/graph-switcher";
import { loadGraphViews } from "./graphs/data";
import { getT } from "@/lib/i18n";
import { hasFeature, isPlatformAdmin, plansEnforced } from "@/lib/plans";
import { getAdminT } from "@/lib/plans/i18n";

export { Mark };

export async function Shell({ viewer, children }: { viewer: Viewer; children: React.ReactNode }) {
  const [graphs, t, psych, medical] = await Promise.all([
    loadGraphViews(viewer).catch((e) => { console.error("[shell] graphs", e); return []; }),
    getT(),
    hasFeature(viewer, "practice_psychology").catch(() => false),
    hasFeature(viewer, "practice_medical").catch(() => false),
  ]);
  // Admin console: platform admins only; the label is translated here so the name never reaches anyone else.
  const adminLabel = isPlatformAdmin(viewer) ? (await getAdminT())("admin.nav.open") : undefined;
  // Practice: accounts with a practice add-on. In development (features on for everyone) only once there's a practice.
  const practice = (psych || medical) && viewer.role !== "guest" && viewer.role !== "child"
    && (plansEnforced() || graphs.some((g) => g.kind === "practice"));
  return (
    <MotionRoot>
      <div className="min-h-full lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="hidden lg:sticky lg:top-0 lg:z-40 lg:flex lg:h-screen lg:flex-col lg:px-3 lg:py-4">
          <GraphSwitcher graphs={graphs} youId={viewer.id} />
          <div className="mt-4 space-y-2 px-1"><SearchField /><AskBox /></div>
          <div className="mt-4 flex-1 overflow-y-auto"><NavLinks role={viewer.role} adminLabel={adminLabel} practice={practice} /></div>
          <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
            <Avatar id={viewer.personNodeId ?? viewer.id} name={viewer.name} size={30} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{viewer.name}</div>
              <div className="text-xs text-muted">{t(`common.roles.${viewer.role}`)}</div>
            </div>
            <form action="/api/auth/logout" method="post">
              <button className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">{t("shell.signOut")}</button>
            </form>
          </div>
        </aside>

        <header className="sticky top-0 z-30 flex items-center gap-2.5 bg-bg/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <Link href="/" aria-label={t("shell.homeLabel")}><Mark size={26} /></Link>
          <div className="min-w-0 flex-1"><AskBox compact /></div>
          <SearchButton />
          <div className="shrink-0"><GraphSwitcher graphs={graphs} youId={viewer.id} compact /></div>
          <Avatar id={viewer.personNodeId ?? viewer.id} name={viewer.name} size={28} />
        </header>

        {/* With the Ask panel open on a wide screen, the page makes room beside it. */}
        <main className="min-w-0 px-4 pb-28 pt-4 transition-[padding] duration-300 sm:px-6 lg:px-10 lg:pb-16 lg:pt-9 xl:in-data-[assistant=open]:pr-[calc(var(--assistant-w)+2.5rem)]">
          <div className="mx-auto max-w-[1180px]">{children}</div>
        </main>
      </div>
      <MobileNav role={viewer.role} adminLabel={adminLabel} practice={practice} />
      <AssistantPanel key={viewer.graphId} />
      <SearchPalette key={`search-${viewer.graphId}`} graphId={viewer.graphId} role={viewer.role}
        graphs={graphs.map((g) => ({ id: g.id, name: g.name, color: g.color, isCurrent: g.isCurrent }))} />
    </MotionRoot>
  );
}
