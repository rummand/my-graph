"use client";
/**
 * ⌘K / Ctrl+K (or "/" when not typing) anywhere: a Spotlight-like search over the current graph. Commands and recently
 * opened things match on every keystroke in the browser; the server is asked ~120 ms after typing pauses
 * (GET /api/search?mode=quick). Combobox + listbox pattern: focus stays in the input, aria-activedescendant points at
 * the active row. Recent searches and opened items are kept per device and per graph (localStorage), never across.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import {
  ArrowRight, BookOpen, Brain, CalendarRange, CornerDownLeft, FilePlus2, FolderOpen, GitPullRequestArrow, History, House, Layers,
  LoaderCircle, MessageCircle, Network, Plug, Scale, Search, Settings, Shapes, Sparkles, Upload, UserPlus, Users, Workflow, X, type LucideIcon,
} from "lucide-react";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { commandsFor, matchCommand, type CommandDef } from "@/lib/search/commands";
import { findRanges } from "@/lib/search/highlight";
import { parseQuery, searchable, textTerms } from "@/lib/search/query";
import { nameScore, TOP_HIT_MIN } from "@/lib/search/rank";
import { pushQuery, pushRecent, readList, recentKey, type RecentItem } from "@/lib/search/access";
import type { Hit, Range, SearchResponse } from "@/lib/search/types";
import { askAssistant } from "@/components/assistant/events";
import { GraphDot } from "@/components/graphs/bits";
import { switchGraph, pathAfterSwitch } from "@/components/graphs/client-api";
import { HitIcon, Marked } from "./bits";
import { SEARCH_EVENT, typingIn, type SearchDetail } from "./events";

const EASE = [0.22, 1, 0.36, 1] as const;

const CMD_ICON: Record<string, LucideIcon> = {
  today: House, ask: MessageCircle, people: Users, timeline: CalendarRange, library: FolderOpen, artifacts: Shapes, rules: Scale,
  graph: Network, connections: Plug, changes: GitPullRequestArrow, history: History, memory: Brain, automations: Workflow,
  graphs: Layers, settings: Settings, help: BookOpen, newPage: FilePlus2, upload: Upload, addPerson: UserPlus, newRuleSet: Scale,
};

export type PaletteGraph = { id: string; name: string; color: number; isCurrent: boolean };

type Row = {
  key: string;
  kind: string;
  title: string;
  titleRanges: Range[];
  context?: string;
  snippet?: { text: string; ranges: Range[] } | null;
  colorId?: string | null;
  sub?: string | null;
  Icon?: LucideIcon;
  hue?: number;
  href?: string;
  run?: () => void | Promise<void>;
  /** Saved to "Recently opened" when opened. */
  remember?: Omit<RecentItem, "at">;
  /** A recent search: picking it fills the field instead of opening something. */
  fill?: string;
};
type Group = { id: string; label: string; rows: Row[] };

const isRecent = (x: unknown): x is RecentItem => !!x && typeof x === "object" && typeof (x as RecentItem).key === "string" && typeof (x as RecentItem).href === "string" && typeof (x as RecentItem).title === "string";
const isString = (x: unknown): x is string => typeof x === "string";

export function SearchPalette({ graphId, role, graphs }: { graphId: string; role: string; graphs: PaletteGraph[] }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const path = usePathname();
  const uid = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const cache = useRef(new Map<string, SearchResponse>());
  const pointerMoved = useRef(false);

  /* Opening and closing ─────────────────────────────────────────────────────────────────────────────── */

  const show = useCallback((initial?: string) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    try {
      setRecentItems(readList(localStorage.getItem(recentKey(graphId, "items")), isRecent));
      setRecentQueries(readList(localStorage.getItem(recentKey(graphId, "queries")), isString));
    } catch { /* storage blocked: no recents */ }
    if (initial !== undefined) setQ(initial);
    setActive(0);
    setOpen(true);
  }, [graphId]);

  const hide = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => returnFocus.current?.focus?.());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) hide(); else show();
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !open && !typingIn(e.target)) {
        e.preventDefault();
        show();
      }
    };
    const onOpen = (e: Event) => show((e as CustomEvent<SearchDetail>).detail?.q);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_EVENT, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(SEARCH_EVENT, onOpen); };
  }, [open, show, hide]);

  useEffect(() => { setOpen(false); }, [path]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    return () => { root.style.overflow = prev; };
  }, [open]);

  /* Asking the server ───────────────────────────────────────────────────────────────────────────────── */

  const parsed = useMemo(() => parseQuery(q), [q]);
  const key = parsed.filter ? `${parsed.filter.label}:${parsed.text}` : parsed.text;

  useEffect(() => {
    if (!open) return;
    if (!searchable(parsed)) { setData(null); setLoading(false); setFailed(false); return; }
    const hit = cache.current.get(key.toLowerCase());
    if (hit) { setData(hit); setLoading(false); setFailed(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?mode=quick&q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as SearchResponse;
        cache.current.set(key.toLowerCase(), json);
        if (cache.current.size > 40) cache.current.delete(cache.current.keys().next().value!);
        setData(json); setFailed(false); setLoading(false);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setFailed(true); setLoading(false);
      }
    }, 120);
    return () => { clearTimeout(timer); ctrl.abort(); };
    // `parsed` follows `key`; `q` only differs from key in whitespace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  /* Rows ────────────────────────────────────────────────────────────────────────────────────────────── */

  const goSearchPage = useCallback((query: string) => {
    hide();
    router.push(query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : "/search");
  }, [hide, router]);

  const groups = useMemo<Group[]>(() => {
    const text = parsed.text;
    const terms = [...parsed.phrases, ...textTerms(parsed)];
    const mark = (s: string) => findRanges(s, terms);
    const cmdRow = (c: CommandDef, ranges?: Range[], title?: string, href?: string): Row => ({
      key: `cmd:${c.id}${title ? ":q" : ""}`, kind: "command", title: title ?? t(c.labelKey), titleRanges: ranges ?? [],
      Icon: CMD_ICON[c.id] ?? ArrowRight, href: href ?? c.href,
    });
    const commands = commandsFor(role);

    if (!q.trim()) {
      const out: Group[] = [];
      if (recentItems.length) out.push({ id: "recent", label: t("search.sections.recent"), rows: recentItems.slice(0, 6).map((r) => ({
        key: `recent:${r.key}`, kind: r.kind, title: r.title, titleRanges: [], context: r.context, colorId: r.colorId, sub: r.sub, href: r.href, remember: r,
      })) });
      if (recentQueries.length) out.push({ id: "queries", label: t("search.sections.recentQueries"), rows: recentQueries.slice(0, 4).map((s) => ({
        key: `q:${s}`, kind: "query", title: s, titleRanges: [], Icon: Search, fill: s,
      })) });
      const quick = ["newPage", "upload", "addPerson", "ask", "library", "people"]
        .map((id) => commands.find((c) => c.id === id)).filter((c): c is CommandDef => !!c);
      out.push({ id: "quick", label: t("search.sections.quick"), rows: quick.map((c) => cmdRow(c)) });
      return out;
    }

    // Commands, instantly.
    const onlyKind = !!parsed.filter;
    const matched = onlyKind ? [] : commands
      .map((c) => ({ c, m: matchCommand(t(c.labelKey), c.keywords, text) }))
      .filter((x): x is { c: CommandDef; m: NonNullable<ReturnType<typeof matchCommand>> } => !!x.m && x.m.score > 0)
      .sort((a, b) => b.m.score - a.m.score).slice(0, 5);
    const strongCommand = matched.find((x) => x.m.score >= TOP_HIT_MIN) ?? null;

    // Server results (possibly from the previous keystroke until the new ones arrive), re-marked for what's typed now.
    const fromServer: { id: string; rows: (Row & { score: number })[] }[] = (data?.sections ?? []).map((s) => ({
      id: s.id,
      rows: s.items.map((h) => hitRow(h, mark, fmt, t)),
    }));
    // Recently opened things whose name matches, so they appear before the server answers.
    const recentMatches = onlyKind ? [] : recentItems
      .map((r) => ({ r, s: nameScore(r.title, text, terms) }))
      .filter((x) => x.s >= TOP_HIT_MIN && !fromServer.some((g) => g.rows.some((row) => row.remember?.key === x.r.key)))
      .slice(0, 3);

    // Top hit: the best of the server's, a strongly matching command, or a recently opened thing.
    type Cand = { row: Row; score: number; from: "server" | "cmd" | "recent" };
    const cands: Cand[] = [];
    if (data?.top && fromServer.length) {
      const row = fromServer.flatMap((g) => g.rows).find((r) => r.key === data.top!.key);
      if (row) cands.push({ row, score: data.top.score, from: "server" });
    }
    if (strongCommand) cands.push({ row: cmdRow(strongCommand.c, strongCommand.m.ranges), score: strongCommand.m.score + 0.5, from: "cmd" });
    for (const x of recentMatches) cands.push({ row: { key: `recent:${x.r.key}`, kind: x.r.kind, title: x.r.title, titleRanges: mark(x.r.title), context: x.r.context, colorId: x.r.colorId, sub: x.r.sub, href: x.r.href, remember: x.r }, score: x.s, from: "recent" });
    cands.sort((a, b) => b.score - a.score);
    const top = cands[0] ?? null;

    const out: Group[] = [];
    if (top) out.push({ id: "top", label: t("search.sections.top"), rows: [top.row] });
    for (const g of fromServer) {
      const rows = g.rows.filter((r) => r.key !== top?.row.key);
      if (rows.length) out.push({ id: g.id, label: t(`search.sections.${g.id}`), rows });
    }
    const recentRest = recentMatches.filter((x) => `recent:${x.r.key}` !== top?.row.key);
    if (recentRest.length && !data) out.push({ id: "recent", label: t("search.sections.recent"), rows: recentRest.map((x) => ({ key: `recent:${x.r.key}`, kind: x.r.kind, title: x.r.title, titleRanges: mark(x.r.title), context: x.r.context, colorId: x.r.colorId, sub: x.r.sub, href: x.r.href, remember: x.r })) });

    const go = matched.filter((x) => x.c.group === "go" && `cmd:${x.c.id}` !== top?.row.key).map((x) => cmdRow(x.c, x.m.ranges));
    if (go.length) out.push({ id: "go", label: t("search.sections.go"), rows: go });

    const doRows: Row[] = matched.filter((x) => x.c.group === "do" && `cmd:${x.c.id}` !== top?.row.key).map((x) => cmdRow(x.c, x.m.ranges));
    const quoted = text.slice(0, 80);
    if (quoted) {
      doRows.push({ key: "do:ask", kind: "command", title: t("search.cmd.askAbout", { q: quoted }), titleRanges: [], Icon: Sparkles,
        run: () => { if (!askAssistant(quoted)) router.push(`/chat?q=${encodeURIComponent(quoted)}`); } });
      if (role !== "guest" && !onlyKind) {
        // Offer to add a person only for something that reads like a name nobody has yet.
        const words = quoted.split(/\s+/);
        const nameLike = /^[\p{L}][\p{L}\s.'-]{0,60}$/u.test(quoted) && words.length <= 4 && (words.length >= 2 || /^\p{Lu}/u.test(quoted));
        const known = data?.top?.kind === "person" && data.top.score >= 92;
        if (nameLike && !known && !strongCommand) {
          const addPerson = commands.find((c) => c.id === "addPerson");
          if (addPerson) doRows.push(cmdRow(addPerson, [], t("search.cmd.addPerson", { q: quoted }), `/people/new?name=${encodeURIComponent(quoted)}`));
        }
        const newPage = commands.find((c) => c.id === "newPage");
        if (newPage && !strongCommand) doRows.push(cmdRow(newPage, [], t("search.cmd.newPageTitled", { q: quoted }), `/artifacts/pages/new?title=${encodeURIComponent(quoted)}`));
      }
    }
    // Switching graphs: by a graph's name, or "switch"/"skift"/"graph".
    const wantsSwitch = /^(switch|skift|graph|graf)/i.test(text);
    for (const g of graphs) {
      if (g.isCurrent || onlyKind) continue;
      const s = nameScore(g.name, text, terms);
      if (s > 0 || wantsSwitch) {
        const title = t("search.cmd.switchGraph", { name: g.name });
        doRows.push({ key: `graph:${g.id}`, kind: "graph", title, titleRanges: s > 0 ? findRanges(title, terms) : [], hue: g.color,
          run: async () => {
            await switchGraph(g.id);
            const next = pathAfterSwitch(path);
            if (next) router.push(next);
            router.refresh();
          } });
      }
    }
    doRows.push({ key: "do:all", kind: "command", title: t("search.cmd.searchAll", { q: quoted }), titleRanges: [], Icon: Search, run: () => goSearchPage(q) });
    out.push({ id: "do", label: t("search.sections.do"), rows: doRows });
    return out;
  }, [q, parsed, data, recentItems, recentQueries, role, graphs, t, fmt, router, path, goSearchPage]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.id }))), [groups]);
  const optionId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => { setActive(0); }, [key]);
  useEffect(() => { if (active >= flat.length) setActive(Math.max(0, flat.length - 1)); }, [flat.length, active]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  /* Acting ──────────────────────────────────────────────────────────────────────────────────────────── */

  const remember = useCallback((row: Row) => {
    try {
      if (q.trim().length >= 2) {
        const qs = pushQuery(readList(localStorage.getItem(recentKey(graphId, "queries")), isString), q);
        localStorage.setItem(recentKey(graphId, "queries"), JSON.stringify(qs));
      }
      if (row.remember) {
        const list = pushRecent(readList(localStorage.getItem(recentKey(graphId, "items")), isRecent), { ...row.remember, at: Date.now() });
        localStorage.setItem(recentKey(graphId, "items"), JSON.stringify(list));
      }
    } catch { /* storage full or blocked */ }
  }, [q, graphId]);

  const choose = useCallback(async (row: Row | undefined) => {
    if (!row) return;
    if (row.fill !== undefined) { setQ(row.fill); input.current?.focus(); return; }
    remember(row);
    if (row.run) {
      hide();
      try { await row.run(); } catch { /* the target screen reports its own errors */ }
      return;
    }
    if (row.href) { hide(); router.push(row.href); }
  }, [remember, hide, router]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + d + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) goSearchPage(q);
      else void choose(flat[active]);
    } else if (e.key === "Tab") {
      if (!flat.length) return;
      e.preventDefault();
      const starts = groups.reduce<number[]>((acc, g, i) => [...acc, i === 0 ? 0 : acc[i - 1] + groups[i - 1].rows.length], []);
      const cur = groups.findIndex((g) => g.id === flat[active]?.group);
      const next = (cur + (e.shiftKey ? -1 : 1) + groups.length) % groups.length;
      setActive(starts[next]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (q && parsed.filter && !parsed.text) setQ("");
      else hide();
    }
  }

  const resultCount = data ? data.sections.reduce((n, s) => n + s.items.length, 0) : 0;
  const announce = !q.trim() ? "" : loading ? t("search.searching") : failed ? t("search.failed")
    : data ? (resultCount ? t("search.results", { count: resultCount }) : t("search.noResults", { graph: graphs.find((g) => g.isCurrent)?.name ?? "", q: parsed.text })) : "";
  const noServerHits = !!q.trim() && !!data && !loading && resultCount === 0 && searchable(parsed);

  let index = -1;
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[58] flex items-start justify-center sm:px-4 sm:pt-[11vh]">
          <motion.div key="scrim" aria-hidden className="absolute inset-0 bg-[color-mix(in_oklab,var(--fg)_22%,transparent)]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15, ease: EASE }} onMouseDown={hide} />
          <motion.div key="panel" role="dialog" aria-modal="true" aria-label={t("search.label")}
            initial={{ opacity: 0, scale: 0.98, y: -6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.985, y: -4 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="relative flex h-full w-full flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)] shadow-float sm:h-auto sm:max-h-[min(660px,78vh)] sm:max-w-[680px] sm:rounded-lg sm:pt-0">
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search className="size-[18px] shrink-0 text-muted" aria-hidden />
              {parsed.filter && (
                <span className="shrink-0 rounded-full bg-accent-tint px-2 py-0.5 text-xs font-medium text-accent">{parsed.filter.label}</span>
              )}
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
                role="combobox" aria-expanded={flat.length > 0} aria-controls={`${uid}-list`} aria-autocomplete="list"
                aria-activedescendant={flat.length ? optionId(active) : undefined} aria-label={t("search.label")}
                placeholder={t("search.placeholder")} autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                style={{ outline: "none" }} className="h-14 min-w-0 flex-1 bg-transparent text-[17px] placeholder:text-muted" />
              {loading && <LoaderCircle className="size-4 shrink-0 animate-spin text-muted motion-reduce:animate-none" aria-hidden />}
              <button type="button" onClick={hide} aria-label={t("search.close")}
                className="-mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg sm:hidden">
                <X className="size-4" aria-hidden />
              </button>
              <kbd className="hidden shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-muted sm:inline">esc</kbd>
            </div>

            <div id={`${uid}-list`} role="listbox" aria-label={t("search.label")} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
              onMouseMove={() => { pointerMoved.current = true; }}>
              {noServerHits && (
                <div className="px-2.5 pb-2 pt-3">
                  <p className="text-[15px]">{t("search.noResults", { graph: graphs.find((x) => x.isCurrent)?.name ?? "", q: parsed.text })}</p>
                  <p className="text-sm text-muted">{t("search.noResultsHint")}</p>
                </div>
              )}
              {failed && !!q.trim() && <p className="px-2.5 pb-1 pt-3 text-sm text-muted">{t("search.failed")}</p>}
              {groups.map((g) => (
                <div key={g.id} role="group" aria-labelledby={`${uid}-g-${g.id}`} className="mb-1.5 last:mb-0">
                  <div id={`${uid}-g-${g.id}`} className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted">{g.label}</div>
                  {g.rows.map((row) => {
                    index += 1;
                    const i = index;
                    const on = i === active;
                    return (
                      <div key={row.key} id={optionId(i)} role="option" aria-selected={on}
                        onMouseMove={() => { if (pointerMoved.current && !on) setActive(i); }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void choose(row)}
                        className={clsx("flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2", on ? "bg-surface-2" : "")}>
                        {row.hue !== undefined
                          ? <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2"><GraphDot hue={row.hue} size={10} /></span>
                          : <HitIcon kind={row.kind} sub={row.sub} title={row.title} colorId={row.colorId} Icon={row.Icon} size={28} className={on ? "bg-surface" : undefined} />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[15px] leading-snug"><Marked text={row.title} ranges={row.titleRanges} /></div>
                          {(row.context || row.snippet?.text) && (
                            <div className="truncate text-xs leading-snug text-muted">
                              {row.context}
                              {row.context && row.snippet?.text ? " · " : ""}
                              {row.snippet?.text && <Marked text={row.snippet.text} ranges={row.snippet.ranges} hitClassName="font-semibold text-fg" />}
                            </div>
                          )}
                        </div>
                        {on && <CornerDownLeft className="size-3.5 shrink-0 text-muted" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              ))}
              {!q.trim() && !recentItems.length && (
                <p className="px-2.5 pb-2 pt-1 text-sm text-muted">{t("search.empty")}</p>
              )}
            </div>

            <div className="hidden items-center gap-4 border-t border-line px-4 py-2 text-xs text-muted sm:flex">
              <span className="flex items-center gap-1.5"><Key>↑</Key><Key>↓</Key>{t("search.hints.move")}</span>
              <span className="flex items-center gap-1.5"><Key>↵</Key>{t("search.hints.open")}</span>
              <span className="flex items-center gap-1.5"><Key>⌘↵</Key>{t("search.hints.all")}</span>
              <span className="flex items-center gap-1.5"><Key>tab</Key>{t("search.hints.section")}</span>
              <span className="ml-auto flex items-center gap-1.5"><Key>esc</Key>{t("search.hints.close")}</span>
            </div>
            <div role="status" aria-live="polite" className="sr-only">{announce}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded bg-surface-2 px-1 font-sans text-[11px] leading-[18px] text-muted">{children}</kbd>;
}

/** A server hit as a palette row: context line in the reader's words, event dates formatted here. */
function hitRow(h: Hit, mark: (s: string) => Range[], fmt: (d: string, s?: "date") => string, t: (k: string, v?: Record<string, string | number>) => string): Row & { score: number } {
  const ctx = [...h.context];
  if (h.kind === "event" && h.date) ctx.splice(1, 0, fmt(h.date, "date"));
  const context = ctx.filter(Boolean).join(" · ");
  const snippet = h.snippet ?? (h.sensitive && h.section === "files" ? { text: t("search.sensitiveHidden"), ranges: [] } : null);
  return {
    key: h.key, kind: h.kind, title: h.title, titleRanges: mark(h.title).length ? mark(h.title) : h.titleRanges, context, snippet,
    colorId: h.colorId, sub: h.sub, href: h.href, score: h.score,
    remember: { key: h.key, kind: h.kind, title: h.title, href: h.href.split("#")[0], context: ctx.slice(0, 2).filter(Boolean).join(" · "), colorId: h.colorId ?? null, sub: h.sub ?? null },
  };
}
