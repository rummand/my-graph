"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Plus, Search, Settings2, X } from "lucide-react";
import { clsx } from "clsx";
import { buttonClass, EmptyState, Input, Select, Tabs } from "@/components/ui";
import { getTemplate } from "@/lib/templates/templates";
import { circleIn, ringsFor } from "@/lib/people/circles";
import type { PeopleOverview as Overview } from "@/lib/people/types";
import { circleName, kindName, localRings } from "@/lib/people/words";
import { AttentionList, attentionText } from "./attention-strip";
import { PersonAvatar } from "./avatar";
import { CirclesLegend, CirclesView } from "./circles-view";
import { api, useFmt, When } from "./format";
import { lastTouch, PeopleTable } from "./people-table";

const VIEW_KEY = "people.view";
type View = "circles" | "list";

/** The header: the title, the one thing that most needs you, and the two actions. Rendered by the client so it follows re-centring. */
function Header({ data, canManageModel }: { data: Overview; canManageModel: boolean }) {
  const f = useFmt();
  const { t } = f;
  const count = data.people.filter((p) => p.id !== data.center?.id).length;
  const first = data.attention[0];
  const countText = data.center && !data.center.isViewer
    ? t("people.overview.countAroundName", { count, name: data.center.label })
    : t("people.overview.countAround", { count });
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("people.title")}</h1>
        <p className="mt-2 max-w-[62ch] text-muted" suppressHydrationWarning>
          {countText}{" "}
          {first
            ? <><span className="text-fg">{attentionText(first, f).title}.</span>{data.attention.length > 1 && ` ${t("people.overview.moreNeedYou", { count: data.attention.length - 1 })}`}</>
            : t("people.overview.allGood")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canManageModel && (
          <Link href="/people/model" className={buttonClass("ghost")}><Settings2 className="size-4" aria-hidden="true" />{t("people.overview.model")}</Link>
        )}
        <Link href={`/people/new${data.center && !data.center.isViewer ? `?relatedTo=${data.center.id}` : ""}`} className={buttonClass("primary")}>
          <Plus className="size-4" aria-hidden="true" />{t("people.overview.add")}
        </Link>
      </div>
    </header>
  );
}

export function PeopleOverview({ initial, canManageModel, graph }: {
  initial: Overview; canManageModel: boolean; graph?: { name: string; kind: string };
}) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<View | null>(null);
  const [circles, setCircles] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  // Faded people (no contact for a long time) are hidden until asked for; search always finds them.
  const [showFaded, setShowFaded] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const f = useFmt();
  const { t } = f;
  const template = data.template ?? graph?.kind ?? "family";
  const tpl = getTemplate(template);
  const rings = useMemo(() => localRings(t, template, ringsFor(template)), [t, template]);
  const circleOrder = useMemo(() => rings.flatMap((r) => r.circles), [rings]);
  const circleOf = useMemo(() => (c: string | null | undefined) => circleIn(tpl, c), [tpl]);

  // Narrow screens start in the list; otherwise remember the last choice.
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch { /* storage blocked */ }
    const narrow = window.matchMedia("(max-width: 640px)").matches;
    setView(narrow ? "list" : saved === "list" ? "list" : "circles");
  }, []);
  const choose = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };

  const recenter = (id: string) => start(async () => {
    setError(null);
    try {
      const next = await api<Overview>(`/api/people${id ? `?center=${id}` : ""}`);
      setData(next);
      const url = new URL(window.location.href);
      if (id && id !== next.centers.find((c) => c.isViewer)?.id) url.searchParams.set("center", id); else url.searchParams.delete("center");
      window.history.replaceState(null, "", url);
    } catch (e) { setError((e as Error).message); }
  });

  const isFaded = (p: Overview["people"][number]) => p.closeness?.band === "faded" && !p.isViewer && p.id !== data.center?.id;
  const fadedCount = data.people.filter(isFaded).length;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.people.filter((p) => {
      if (!showFaded && !needle && p.closeness?.band === "faded" && !p.isViewer && p.id !== data.center?.id) return false;
      if (circles.size && !circles.has(circleOf(p.circle))) return false;
      if (kind && p.kind !== kind) return false;
      if (needle && ![p.label, p.kindLabel, p.kindLabel && kindName(t, p.kindLabel), p.relation?.label, ...(p.roles ?? []).map((r) => r.text)].some((s) => s?.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [data.people, data.center, circles, kind, q, circleOf, t, showFaded]);
  const listPeople = filtered.filter((p) => !p.isViewer);
  const byId = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people]);
  const overdue = useMemo(() => new Map(data.attention.flatMap((a) => (a.reason === "contact" ? [[a.personId, a.daysSince] as const] : []))), [data.attention]);

  const circleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data.people) {
      if (p.id === data.center?.id || (!showFaded && p.closeness?.band === "faded" && !p.isViewer)) continue;
      m.set(circleOf(p.circle), (m.get(circleOf(p.circle)) ?? 0) + 1);
    }
    return m;
  }, [data.people, data.center, circleOf, showFaded]);
  const toggleCircle = (c: string) => setCircles((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const filtering = circles.size > 0 || !!kind || !!q;
  const clear = () => { setCircles(new Set()); setKind(""); setQ(""); };
  const centerName = data.center && !data.center.isViewer ? data.center.label : t("people.youLower");
  const recent = useMemo(() => data.people.filter((p) => lastTouch(p) && p.id !== data.center?.id && !p.isViewer)
    .sort((a, b) => lastTouch(b)!.localeCompare(lastTouch(a)!)).slice(0, 5), [data.people, data.center]);

  if (data.people.length <= (data.center ? 1 : 0)) {
    const you = data.center?.isViewer ? data.center : null;
    const emptyKey = ["family", "work", "project", "partner", "personal"].includes(tpl.kind) ? tpl.kind : "other";
    return (
      <>
        <Header data={data} canManageModel={canManageModel} />
        <EmptyState title={t(you ? "people.overview.justYou" : "people.overview.noOne")}
          icon={you ? <Link href={`/people/${you.id}`} aria-label={t("people.overview.yourPage")} className="block rounded-full"><PersonAvatar id={you.id} label={you.label} size={56} /></Link> : undefined}
          action={<Link href="/people/new" className={buttonClass("primary")}><Plus className="size-4" aria-hidden="true" />{t("people.overview.addA")}</Link>}>
          {t(`people.overview.empty.${emptyKey}`, { graph: graph?.name ?? "" })}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <Header data={data} canManageModel={canManageModel} />
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-label={t("people.title")} className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Tabs<View> value={view ?? "circles"} onSelect={choose} items={[{ value: "circles", label: t("people.overview.circles") }, { value: "list", label: t("people.overview.list") }]} />
            {data.centers.length > 1 && (
              <label className="inline-flex items-center gap-2 text-sm">
                <span className="text-muted">{t("people.overview.around")}</span>
                <Select value={data.center?.id ?? ""} onChange={(e) => recenter(e.target.value)} disabled={pending} className="h-9 !w-auto text-sm">
                  {data.centers.map((c) => <option key={c.id} value={c.id}>{c.isViewer ? t("people.you") : c.label}</option>)}
                </Select>
              </label>
            )}
            <label className="inline-flex">
              <span className="sr-only">{t("people.overview.kind")}</span>
              <Select value={kind} onChange={(e) => setKind(e.target.value)} className="h-9 !w-auto text-sm">
                <option value="">{t("people.overview.allKinds")}</option>
                {data.kinds.filter((k) => data.people.some((p) => p.kind === k.key)).map((k) => <option key={k.key} value={k.key}>{kindName(t, k.label)}</option>)}
              </Select>
            </label>
            <div className="relative min-w-[11rem] flex-1 sm:max-w-[240px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("people.overview.find")} aria-label={t("people.overview.search")} className="pl-8 text-sm" />
            </div>
          </div>

          <div role="group" aria-label={t("people.overview.showCircles")} className="mb-4 flex flex-wrap items-center gap-1.5">
            {circleOrder.filter((c) => circleCounts.has(c)).map((c) => {
              const on = circles.has(c);
              return (
                <button key={c} type="button" aria-pressed={on} onClick={() => toggleCircle(c)}
                  className={clsx("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors active:scale-[0.97]",
                    on ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
                  {circleName(t, template, c)}
                  <span className={clsx("tabular-nums", on ? "text-bg/80" : "text-muted")}>{circleCounts.get(c)}</span>
                </button>
              );
            })}
            {fadedCount > 0 && (
              <button type="button" aria-pressed={showFaded} onClick={() => setShowFaded((x) => !x)} title={t("closeness.fadedHint")}
                className="inline-flex h-8 items-center rounded-full px-2.5 text-sm text-muted transition-colors hover:text-fg">
                {showFaded ? t("closeness.hideFaded") : t("closeness.showFaded", { count: fadedCount })}
              </button>
            )}
            {filtering && (
              <button type="button" onClick={clear} className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-sm text-muted hover:text-fg">
                <X className="size-3.5" aria-hidden="true" />{t("people.overview.clear")}
              </button>
            )}
          </div>

          {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
          <p className="sr-only" aria-live="polite">{pending ? t("people.overview.loading") : t("people.overview.live", { count: listPeople.length, name: centerName })}</p>

          <div className={clsx("transition-opacity duration-200", pending && "opacity-60")}>
            {view === null ? (
              <div className="h-[460px] rounded-lg bg-surface" aria-hidden="true" />
            ) : listPeople.length === 0 ? (
              <EmptyState title={t("people.overview.noMatch")} action={<button type="button" onClick={clear} className={buttonClass("secondary", "sm")}>{t("people.overview.clearFilters")}</button>}>
                {q ? t("people.overview.nobodyCalled", { q }) : t("people.overview.nobodyHere")}
              </EmptyState>
            ) : view === "circles" ? (
              <div className="rounded-lg bg-surface px-4 pb-4 pt-4 sm:px-6">
                <CirclesView people={filtered} center={data.center} overdue={overdue} rings={rings} family={data.family ?? template === "family"} />
                <div className="mt-3"><CirclesLegend /></div>
              </div>
            ) : (
              <PeopleTable people={listPeople} overdue={overdue}
                relationHeading={data.center && !data.center.isViewer ? t("people.overview.relationTo", { name: data.center.label }) : t("people.overview.relationToYou")} />
            )}
          </div>
        </section>

        <aside className="min-w-0 space-y-9">
          <section aria-labelledby="attention-h">
            <h2 id="attention-h" className="mb-2 text-lg font-semibold tracking-[-0.01em]">
              {t("people.overview.needsYou")} {data.attention.length > 0 && <span className="font-normal text-muted tabular-nums">{data.attention.length}</span>}
            </h2>
            <AttentionList items={data.attention} people={byId} />
          </section>
          <section aria-labelledby="recent-h">
            <h2 id="recent-h" className="mb-2 text-lg font-semibold tracking-[-0.01em]">{t("people.overview.lastInTouch")}</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-muted">{t("people.overview.recentEmpty")}</p>
            ) : (
              <ul className="-mx-2">
                {recent.map((p) => (
                  <li key={p.id}>
                    <Link href={`/people/${p.id}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/70">
                      <PersonAvatar id={p.id} label={p.label} size={26} />
                      <span className="min-w-0 flex-1 truncate text-sm">{p.label}</span>
                      <When iso={lastTouch(p)} className={clsx("shrink-0 text-[13px] tabular-nums", overdue.has(p.id) ? "text-warn" : "text-muted")} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
