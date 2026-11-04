"use client";
import { Plus } from "lucide-react";
import { clsx } from "clsx";
import type { TypeaheadItem } from "./use-mention-typeahead";
import { useT } from "@/lib/i18n/client";
import { typeColor } from "./colors";

/** The typeahead list: type dot, name, kind; and "Create new …" at the end. */
export function MentionMenu({ id, items, active, onPick, onHover, loading, query, className }: {
  id: string; items: TypeaheadItem[]; active: number; onPick: (i: TypeaheadItem) => void; onHover: (i: number) => void;
  loading: boolean; query: string; className?: string;
}) {
  const t = useT();
  return (
    <div className={clsx("z-40 w-72 max-w-[calc(100vw-32px)] overflow-hidden rounded-lg bg-surface py-1 shadow-float", className)}>
      <ul id={id} role="listbox" aria-label={t("mention.menu")}>
        {items.map((it, i) => (
          <li key={it.kind === "node" ? it.m.nodeId : "create"} id={`${id}-${i}`} role="option" aria-selected={i === active}
            onMouseDown={(e) => { e.preventDefault(); onPick(it); }} onMouseEnter={() => onHover(i)}
            className={clsx("flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm", i === active && "bg-surface-2")}>
            {it.kind === "node" ? (
              <>
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: typeColor(it.m.type) }} />
                <span className="min-w-0 flex-1 truncate">{it.m.label}{it.m.isYou ? t("mention.youSuffix") : ""}</span>
                <span className="shrink-0 text-xs text-muted">{it.m.kindLabel ?? it.m.typeLabel}</span>
              </>
            ) : (
              <>
                <Plus aria-hidden className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{t("mention.create", { label: it.label })}</span>
                <span className="shrink-0 text-xs text-muted">{t("mention.addedOnSend")}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {loading && !items.length && <p className="px-3 py-1.5 text-sm text-muted">{t("mention.looking", { q: query })}</p>}
    </div>
  );
}
