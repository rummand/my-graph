"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { CircleDot, LayoutList, Plus, Search, Settings2 } from "lucide-react";
import { clsx } from "clsx";
import { Button, EmptyState, Input } from "@/components/ui";
import { CIRCLE_VAR, normaliseCircle, RINGS } from "@/lib/people/circles";
import type { PeopleOverview as Overview } from "@/lib/people/types";
import { AttentionStrip } from "./attention-strip";
import { CirclesView } from "./circles-view";
import { api } from "./format";
import { PeopleTable } from "./people-table";

const CIRCLE_CHIPS = RINGS.flatMap((r) => r.circles);
const CHIP_LABEL: Record<string, string> = { family: "Family", close: "Close friends", school: "School", care: "Care", social: "Friends & neighbours", work: "Work", other: "Others" };
const VIEW_KEY = "people.view";

export function PeopleOverview({ initial, canManageModel }: { initial: Overview; canManageModel: boolean }) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<"circles" | "list" | null>(null);
  const [circles, setCircles] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Narrow screens start in the list; otherwise remember the last choice.
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch { /* storage blocked */ }
    const narrow = window.matchMedia("(max-width: 640px)").matches;
    setView(narrow ? "list" : saved === "list" ? "list" : "circles");
  }, []);
  const choose = (v: "circles" | "list") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };

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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.people.filter((p) => {
      if (circles.size && !circles.has(normaliseCircle(p.circle))) return false;
      if (kind && p.kind !== kind) return false;
      if (needle && ![p.label, p.kindLabel, p.relation?.label].some((s) => s?.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [data.people, circles, kind, q]);
  const listPeople = filtered.filter((p) => !p.isViewer);

  const toggleCircle = (c: string) => setCircles((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const centerName = data.center ? (data.center.isViewer ? "you" : data.center.label) : "you";
  const presentCircles = new Set(data.people.map((p) => normaliseCircle(p.circle)));

  if (data.people.length <= (data.center ? 1 : 0)) {
    return (
      <EmptyState title="No one here yet">
        <p>Add the people around your family — grandparents, teachers, the doctor, friends — and see them in circles.</p>
        <Link href="/people/new" className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg"><Plus className="h-4 w-4" aria-hidden="true" />Add a person</Link>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <AttentionStrip items={data.attention} />

      <section aria-label="People" className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="View" className="inline-flex rounded-md border border-line bg-surface p-0.5">
            <button type="button" aria-pressed={view === "circles"} onClick={() => choose("circles")}
              className={clsx("inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm", view === "circles" ? "bg-accent-tint font-medium text-accent" : "text-muted hover:text-fg")}>
              <CircleDot className="h-4 w-4" aria-hidden="true" />Circles
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => choose("list")}
              className={clsx("inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm", view === "list" ? "bg-accent-tint font-medium text-accent" : "text-muted hover:text-fg")}>
              <LayoutList className="h-4 w-4" aria-hidden="true" />List
            </button>
          </div>

          {data.centers.length > 1 && (
            <label className="inline-flex items-center gap-2 text-sm">
              <span className="text-muted">Around</span>
              <select value={data.center?.id ?? ""} onChange={(e) => recenter(e.target.value)} disabled={pending}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm">
                {data.centers.map((c) => <option key={c.id} value={c.id}>{c.isViewer ? "You" : c.label}</option>)}
              </select>
            </label>
          )}

          <label className="inline-flex items-center gap-2 text-sm">
            <span className="sr-only">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm">
              <option value="">All kinds</option>
              {data.kinds.filter((k) => data.people.some((p) => p.kind === k.key)).map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </label>

          <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" className="pl-8" />
          </div>

          <div className="ml-auto flex gap-2">
            {canManageModel && <Link href="/people/model" className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg"><Settings2 className="h-4 w-4" aria-hidden="true" />Kinds & relations</Link>}
            <Link href={`/people/new${data.center && !data.center.isViewer ? `?relatedTo=${data.center.id}` : ""}`} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90"><Plus className="h-4 w-4" aria-hidden="true" />Add person</Link>
          </div>
        </div>

        <div role="group" aria-label="Show circles" className="flex flex-wrap gap-1.5">
          {CIRCLE_CHIPS.filter((c) => presentCircles.has(c)).map((c) => (
            <button key={c} type="button" aria-pressed={circles.has(c)} onClick={() => toggleCircle(c)}
              className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", circles.has(c) ? "border-fg bg-surface-2 font-medium" : "border-line text-muted hover:text-fg")}>
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: CIRCLE_VAR[c] }} />{CHIP_LABEL[c]}
            </button>
          ))}
          {(circles.size > 0 || kind || q) && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => { setCircles(new Set()); setKind(""); setQ(""); }}>Clear filters</Button>}
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <p className="sr-only" aria-live="polite">{pending ? "Loading…" : `${listPeople.length} people around ${centerName}`}</p>

        <div className={clsx(pending && "opacity-60 transition-opacity")}>
          {view === null ? (
            <div className="h-64 animate-pulse rounded-lg bg-surface-2" aria-hidden="true" />
          ) : listPeople.length === 0 ? (
            <EmptyState title="No one matches">Try clearing the filters.</EmptyState>
          ) : view === "circles" ? (
            <div className="rounded-lg border border-line bg-surface p-2 sm:p-4">
              <CirclesView people={filtered} center={data.center} />
            </div>
          ) : (
            <PeopleTable people={listPeople} relationHeading={data.center && !data.center.isViewer ? `Relation to ${data.center.label}` : "Relation to you"} />
          )}
        </div>
      </section>
    </div>
  );
}
