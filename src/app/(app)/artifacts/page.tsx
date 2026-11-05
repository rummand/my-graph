import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { Search, Shapes, X } from "lucide-react";
import { ArtifactsHubHeader, newMenuItems } from "@/components/artifacts/hub";
import { MadeRow } from "@/components/artifacts/made-list";
import { EmptyState, Input } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { availableKinds, isMadeKind, MADE } from "@/lib/artifacts/kinds";
import { listMade } from "@/lib/artifacts/made";
import { formatAgo, getPrefs, getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("artifacts.hub.metaTitle") };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Artifacts → All: everything made in this graph, newest first, with kind chips, search and "only mine". */
export default async function ArtifactsHub({ searchParams }: Props) {
  const v = await requireUser();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const q = one("q").trim().slice(0, 200);
  const kind = isMadeKind(one("kind")) && MADE[one("kind") as keyof typeof MADE].available ? (one("kind") as keyof typeof MADE) : null;
  const mine = one("mine") === "1";
  const [t, prefs] = await Promise.all([getT(), getPrefs()]);
  const items = await listMade(v, { kind, q, mine });
  const ago = (d: string) => formatAgo(d, prefs.locale);
  const filtered = !!(q || kind || mine);

  const href = (next: { kind?: string | null; mine?: boolean }) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    const k = next.kind === undefined ? kind : next.kind;
    if (k) p.set("kind", k);
    if (next.mine ?? mine) p.set("mine", "1");
    const s = p.toString();
    return s ? `/artifacts?${s}` : "/artifacts";
  };
  const chip = (on: boolean) => clsx("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
    on ? "bg-fg text-bg" : "bg-surface text-muted hover:text-fg");
  const first = newMenuItems(v, t)[0];

  return (
    <div>
      <ArtifactsHubHeader v={v} t={t} active="all" lead={t("artifacts.hub.lead", { graph: v.graphName })} />
      <div className="max-w-4xl">

      <div className="mb-6 grid gap-3">
        <form role="search" action="/artifacts" method="get" className="relative max-w-xl">
          <label htmlFor="made-q" className="sr-only">{t("artifacts.hub.searchLabel")}</label>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input id="made-q" name="q" type="search" defaultValue={q} placeholder={t("artifacts.hub.searchPlaceholder")} className="h-10 pl-9" />
          {kind && <input type="hidden" name="kind" value={kind} />}
          {mine && <input type="hidden" name="mine" value="1" />}
        </form>
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t("artifacts.hub.filterLabel")}>
          <Link href={href({ kind: null })} aria-current={!kind ? "true" : undefined} className={chip(!kind)}>{t("artifacts.hub.everything")}</Link>
          {availableKinds().map((k) => (
            <Link key={k.id} href={href({ kind: k.id })} aria-current={kind === k.id ? "true" : undefined} className={chip(kind === k.id)}>{t(k.plural)}</Link>
          ))}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <Link href={href({ mine: !mine })} aria-pressed={mine} className={chip(mine)}>{t("artifacts.hub.onlyMine")}</Link>
        </div>
      </div>

      {filtered && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold tracking-[-0.01em]">
            {items.length === 0 ? t("artifacts.hub.noMatch") : t("artifacts.hub.matches", { count: items.length })}
          </h2>
          <Link href="/artifacts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><X aria-hidden className="size-3.5" />{t("artifacts.hub.clear")}</Link>
        </div>
      )}

      {items.length === 0 ? (
        filtered ? <p className="max-w-[60ch] text-muted">{t("artifacts.hub.noMatchHelp")}</p> : (
          <EmptyState title={t("artifacts.hub.empty.title")} icon={<Shapes className="size-6" />}
            action={first ? <Link href={first.href} className="text-sm font-medium text-accent hover:underline">{t("artifacts.hub.empty.action")}</Link> : undefined}>
            {t("artifacts.hub.empty.body")}
          </EmptyState>
        )
      ) : (
        <ul className="-mx-2">{items.map((i) => <MadeRow key={`${i.kind}:${i.id}`} item={i} t={t} ago={ago} />)}</ul>
      )}
      </div>
    </div>
  );
}
