"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Check, ChevronsUpDown, Plus, Settings2 } from "lucide-react";
import { Mark } from "@/components/mark";
import { GraphDot, MemberStack } from "./bits";
import { firstName, graphStyle, groupGraphs, others, ownerOf, type GraphView } from "./describe";
import { pathAfterSwitch, switchGraph } from "./client-api";
import { useT, type TFn } from "@/lib/i18n/client";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Who else is in a graph, in the reader's language (the same rules as `sharingLine` in ./describe). */
function sharing(g: GraphView, youId: string, t: TFn): string | null {
  const rest = others(g, youId).map((m) => firstName(m.name));
  if (g.isFamily) return rest.length ? t("graphs.sharing.familyWith", { count: rest.length + 1 }) : t("graphs.sharing.family");
  if (g.myRole !== "owner") {
    const owner = ownerOf(g);
    return owner ? t("graphs.sharing.sharedBy", { name: firstName(owner.name) }) : t("graphs.sharing.sharedWithYou");
  }
  if (!rest.length) return null;
  const names = rest.length === 1 ? rest[0] : rest.length === 2 ? t("graphs.sharing.and", { a: rest[0], b: rest[1] })
    : t("graphs.sharing.andOthers", { name: rest[0], count: rest.length - 1 });
  return t("graphs.sharing.sharedWith", { names });
}

/**
 * Which graph you are working in. In the rail it is the product block itself: the mark (with the graph's colour on
 * its corner), "My Graph", then the graph. On phones a compact chip in the top bar. Opens a list to switch graphs.
 */
export function GraphSwitcher({ graphs, youId, compact = false }: { graphs: GraphView[]; youId: string; compact?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const t = useT();
  const current = graphs.find((g) => g.isCurrent) ?? graphs[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Put focus on the graph you're in, so arrows move from there.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>("[data-current=true]")?.focus());
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  useEffect(() => { setOpen(false); }, [path]);

  if (!current) return null;
  const { mine, shared } = groupGraphs(graphs);
  const hint = sharing(current, youId, t);

  async function choose(id: string) {
    if (id === current.id) { setOpen(false); return; }
    setBusyId(id); setError(null);
    try {
      await switchGraph(id);
      setOpen(false);
      const next = pathAfterSwitch(path);
      if (next) router.push(next);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function onListKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-item]") ?? []);
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
      : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const style = graphStyle(current.color) as CSSProperties;

  return (
    <div ref={box} className="relative" style={style}>
      {compact ? (
        <button ref={trigger} type="button" data-graph-switcher onClick={() => setOpen((o) => !o)}
          aria-expanded={open} aria-haspopup="dialog" aria-label={t("graphs.switcher.triggerCompact", { name: current.name })}
          className="flex h-9 max-w-[148px] items-center gap-1.5 rounded-full bg-[var(--g-tint)] pl-2.5 pr-2 text-sm font-medium transition-colors hover:brightness-[0.97] active:scale-[0.98]">
          <GraphDot hue={current.color} size={8} />
          <span className="min-w-0 truncate">{current.name}</span>
          <ChevronsUpDown size={13} className="shrink-0 text-muted" aria-hidden />
        </button>
      ) : (
        <button ref={trigger} type="button" data-graph-switcher onClick={() => setOpen((o) => !o)}
          aria-expanded={open} aria-haspopup="dialog" aria-label={t("graphs.switcher.trigger", { name: current.name })}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2/70">
          <span className="relative shrink-0">
            <Mark size={30} />
            <span aria-hidden className="absolute -bottom-1 -right-1 size-3.5 rounded-full bg-[var(--g)] ring-[2.5px] ring-bg" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-xs text-muted">{t("graphs.switcher.product")}</span>
            <span className="block truncate text-[15px] font-semibold">{current.name}</span>
            {hint && <span className="mt-0.5 block truncate text-xs text-muted">{hint}</span>}
          </span>
          <ChevronsUpDown size={15} className="shrink-0 text-muted transition-colors group-hover:text-fg" aria-hidden />
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={t("graphs.switcher.dialog")}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.18, ease: EASE } }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: EASE } }}
            style={{ transformOrigin: compact ? "top right" : "top left" }}
            className={clsx(
              "absolute z-50 mt-1.5 w-[320px] max-w-[calc(100vw-32px)] rounded-lg bg-surface p-1.5 shadow-float",
              compact ? "right-0" : "left-0",
            )}
          >
            <div ref={list} onKeyDown={onListKey} className="max-h-[min(60vh,440px)] overflow-y-auto">
              <Group title={shared.length ? t("graphs.switcher.mine") : null}>
                {mine.map((g) => <Row key={g.id} g={g} youId={youId} busy={busyId === g.id} disabled={!!busyId} onChoose={choose} />)}
              </Group>
              {shared.length > 0 && (
                <Group title={t("graphs.switcher.sharedWithMe")}>
                  {shared.map((g) => <Row key={g.id} g={g} youId={youId} busy={busyId === g.id} disabled={!!busyId} onChoose={choose} />)}
                </Group>
              )}
            </div>
            {error && <p role="alert" className="px-2.5 pb-1 pt-1.5 text-sm text-danger">{error}</p>}
            <p className="px-2.5 pb-2 pt-2 text-xs text-muted">{t("graphs.switcher.separate")}</p>
            <div className="flex justify-between gap-1 border-t border-line pt-1.5">
              <Link href="/graphs?new=1" onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium hover:bg-surface-2">
                <Plus size={15} aria-hidden /> {t("graphs.switcher.newGraph")}
              </Link>
              <Link href="/graphs" onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
                <Settings2 size={15} aria-hidden /> {t("graphs.switcher.manage")}
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Group({ title, children }: { title: string | null; children: React.ReactNode }) {
  return (
    <div className="pb-1">
      {title && <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted">{title}</p>}
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

function Row({ g, youId, busy, disabled, onChoose }: { g: GraphView; youId: string; busy: boolean; disabled: boolean; onChoose: (id: string) => void }) {
  const t = useT();
  const line = busy ? t("graphs.switcher.opening") : sharing(g, youId, t) ?? t("graphs.switcher.onlyYou");
  return (
    <li>
      <button type="button" data-item data-current={g.isCurrent} disabled={disabled} onClick={() => onChoose(g.id)}
        aria-current={g.isCurrent ? "true" : undefined}
        className={clsx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-offset-[-2px] disabled:cursor-wait",
          g.isCurrent ? "bg-surface-2" : "hover:bg-surface-2/70")}
       >
        <GraphDot hue={g.color} size={10} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[15px] font-medium">{g.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">{line}</span>
        </span>
        <MemberStack people={others(g, youId).length ? g.members : []} max={g.members.length > 3 ? 2 : 3} size={20} />
        <span className="flex w-4 shrink-0 justify-end">
          {g.isCurrent && <Check size={15} className="text-fg" aria-label={t("graphs.switcher.current")} />}
        </span>
      </button>
    </li>
  );
}
