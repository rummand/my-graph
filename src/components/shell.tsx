import Link from "next/link";
import type { Viewer } from "@/lib/auth";
import { Avatar } from "@/components/ui";
import { NavLinks, MobileNav } from "./nav-links";
import { AskBox } from "./ask-box";
import { MotionRoot } from "./motion-root";
import { Mark } from "./mark";
import { GraphSwitcher } from "./graphs/graph-switcher";
import { loadGraphViews } from "./graphs/data";

export { Mark };

export async function Shell({ viewer, children }: { viewer: Viewer; children: React.ReactNode }) {
  const graphs = await loadGraphViews(viewer).catch((e) => { console.error("[shell] graphs", e); return []; });
  return (
    <MotionRoot>
      <div className="min-h-full lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="hidden lg:sticky lg:top-0 lg:z-40 lg:flex lg:h-screen lg:flex-col lg:px-3 lg:py-4">
          <GraphSwitcher graphs={graphs} youId={viewer.id} />
          <div className="mt-4 px-1"><AskBox /></div>
          <div className="mt-4 flex-1 overflow-y-auto"><NavLinks role={viewer.role} /></div>
          <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
            <Avatar id={viewer.personNodeId ?? viewer.id} name={viewer.name} size={30} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{viewer.name}</div>
              <div className="text-xs capitalize text-muted">{viewer.role}</div>
            </div>
            <form action="/api/auth/logout" method="post">
              <button className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">Sign out</button>
            </form>
          </div>
        </aside>

        <header className="sticky top-0 z-30 flex items-center gap-3 bg-bg/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <Link href="/" aria-label="Today"><Mark size={26} /></Link>
          <div className="min-w-0 flex-1"><AskBox compact /></div>
          <div className="shrink-0"><GraphSwitcher graphs={graphs} youId={viewer.id} compact /></div>
          <Avatar id={viewer.personNodeId ?? viewer.id} name={viewer.name} size={28} />
        </header>

        <main className="min-w-0 px-4 pb-28 pt-4 sm:px-6 lg:px-10 lg:pb-16 lg:pt-9">
          <div className="mx-auto max-w-[1180px]">{children}</div>
        </main>
      </div>
      <MobileNav role={viewer.role} />
    </MotionRoot>
  );
}
