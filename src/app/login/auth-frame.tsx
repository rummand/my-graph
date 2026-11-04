import type { CSSProperties, ReactNode } from "react";
import { Mark } from "@/components/shell";
import { personStyle } from "@/lib/ui/person-color";
import { getT } from "@/lib/i18n";
import { LanguageSwitch } from "./language-switch";

/**
 * The signed-out pages (sign in, first-run setup, waiting for approval).
 * Wide screens: the product's face on the ground at left, the task on a surface at right.
 * Phones: the mark, then the task.
 */
export async function AuthFrame({ title, lead, children, footer, welcome }: {
  title: string; lead?: ReactNode; children: ReactNode; footer?: ReactNode;
  welcome?: { title: string; body: ReactNode };
}) {
  const t = await getT();
  const w = welcome ?? { title: t("auth.frame.welcomeTitle"), body: t("auth.frame.welcomeBody") };
  return (
    <main className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(480px,44%)]">
      <aside className="flex flex-col px-5 pt-6 sm:px-8 lg:min-h-dvh lg:px-14 lg:py-12">
        <div className="flex items-center gap-2.5">
          <Mark size={30} />
          <span className="flex-1 text-[17px] font-semibold tracking-[-0.01em]">{t("auth.frame.product")}</span>
          <LanguageSwitch className="lg:hidden" />
        </div>
        <div className="my-auto hidden max-w-[30rem] py-12 lg:block">
          <FamilyMotif />
          <p className="mt-10 text-[28px]/[1.2] font-semibold tracking-[-0.02em] text-balance">{w.title}</p>
          <p className="mt-4 max-w-[44ch] text-muted">{w.body}</p>
        </div>
        <div className="hidden items-center justify-between gap-4 lg:flex">
          <p className="text-sm text-muted">{t("auth.frame.selfHosted")}</p>
          <LanguageSwitch />
        </div>
      </aside>
      <section className="flex px-5 pb-12 pt-10 sm:px-8 lg:items-center lg:bg-surface lg:px-16 lg:py-12">
        <div className="w-full max-w-[380px] sm:mx-auto lg:mx-0">
          <h1 className="text-[26px]/[1.15] font-semibold tracking-[-0.02em] text-balance">{title}</h1>
          {lead && <div className="mt-2 text-muted">{lead}</div>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-muted">{footer}</div>}
        </div>
      </section>
    </main>
  );
}

/* A small household drawn as the graph the product keeps: each person in their own colour, joined. */
const PEOPLE: { id: string; x: number; y: number; r: number }[] = [
  { id: "parent-a", x: 60, y: 46, r: 20 },
  { id: "parent-b", x: 164, y: 34, r: 20 },
  { id: "child-a", x: 104, y: 122, r: 16 },
  { id: "child-b", x: 214, y: 116, r: 16 },
  { id: "grandma", x: 286, y: 52, r: 13 },
];
const LINKS: [number, number][] = [[0, 1], [0, 2], [1, 2], [1, 3], [0, 3], [1, 4]];

function FamilyMotif() {
  return (
    <svg viewBox="0 0 320 160" width={400} height={200} aria-hidden className="block max-w-full overflow-visible">
      {LINKS.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={PEOPLE[a].x} y1={PEOPLE[a].y} x2={PEOPLE[b].x} y2={PEOPLE[b].y} className="stroke-line" strokeWidth={1.5} />
      ))}
      {PEOPLE.map((p) => (
        <g key={p.id} style={personStyle(p.id) as CSSProperties}>
          <circle cx={p.x} cy={p.y} r={p.r} fill="var(--person-tint)" />
          <circle cx={p.x} cy={p.y} r={p.r * 0.32} fill="var(--person)" />
        </g>
      ))}
      <rect x={178} y={68} width={22} height={14} rx={3} className="fill-accent-tint" />
      <text x={189} y={78.5} textAnchor="middle" className="fill-accent text-[9px] font-semibold">1</text>
    </svg>
  );
}
