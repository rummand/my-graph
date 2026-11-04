"use client";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { formatAgo, useLocale, useT } from "@/lib/i18n/client";
import type { MentionCard } from "@/lib/mentions";
import { typeColor, typeTint } from "./colors";

const EASE = [0.22, 1, 0.36, 1] as const;
const cards = new Map<string, Promise<MentionCard | null>>();

function loadCard(nodeId: string): Promise<MentionCard | null> {
  let p = cards.get(nodeId);
  if (!p) {
    p = fetch(`/api/mentions/${nodeId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    cards.set(nodeId, p);
    void p.then((c) => { if (!c) cards.delete(nodeId); });
  }
  return p;
}

/** A mention in running text: its name in a soft chip marked with the type colour; hover or focus shows a card. */
export function MentionChip({ nodeId, label, type, className }: { nodeId: string; label: string; type?: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<MentionCard | null | undefined>(undefined);
  const [below, setBelow] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  const t = card?.type ?? type ?? null;
  // Learn the type colour early: fetch the card in the background on first render (cached per page).
  useEffect(() => { if (!type) void loadCard(nodeId).then((c) => setCard((cur) => (cur === undefined ? c : cur))); }, [nodeId, type]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // Open below when there isn't room above (a mention near the top of the window).
      setBelow((anchor.current?.getBoundingClientRect().top ?? 999) < 240);
      setOpen(true);
      if (card === undefined) void loadCard(nodeId).then(setCard);
    }, 220);
  };
  const hide = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 120); };

  return (
    <span ref={anchor} className="relative inline" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <Link href={`/node/${nodeId}`} aria-describedby={open ? id : undefined}
        className={`rounded-[4px] px-0.5 font-medium text-fg underline decoration-1 underline-offset-[3px] transition-colors ${className ?? ""}`}
        style={{ background: typeTint(t, 12), textDecorationColor: typeColor(t) } as CSSProperties}>
        {label}
      </Link>
      <AnimatePresence>
        {open && (
          <motion.span id={id} role="tooltip" initial={{ opacity: 0, y: below ? -4 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15, ease: EASE }}
            onMouseEnter={show} onMouseLeave={hide}
            className={`absolute left-0 z-40 block w-72 max-w-[calc(100vw-32px)] rounded-lg bg-surface p-3 text-left text-sm font-normal tracking-normal text-fg shadow-float ${below ? "top-full mt-1.5" : "bottom-full mb-1.5"}`}>
            <HoverCardBody card={card} label={label} type={t} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function HoverCardBody({ card, label, type }: { card: MentionCard | null | undefined; label: string; type: string | null }) {
  const t = useT();
  const locale = useLocale();
  if (card === undefined) return <span className="block text-muted">{t("mention.lookingUp", { label })}</span>;
  if (card === null) return <span className="block text-muted">{t("mention.notVisible", { label })}</span>;
  return (
    <span className="block">
      <span className="flex items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: typeColor(type) }} />
        <span className="min-w-0 flex-1 truncate font-semibold">{card.isYou ? t("mention.you", { label: card.label }) : card.label}</span>
      </span>
      <span className="mt-0.5 block text-xs text-muted">
        {card.kindLabel ?? card.typeLabel}{card.emergentKind ? t("mention.learning") : ""}
      </span>
      {card.summary && <span className="mt-2 line-clamp-2 block text-muted">{card.summary}</span>}
      {card.facts.length > 0 && (
        <span className="mt-2 block space-y-0.5">
          {card.facts.map((f, i) => (
            <span key={i} className="block truncate"><span className="text-muted">{f.relation}</span> {f.otherLabel}</span>
          ))}
        </span>
      )}
      {card.latest && (
        <span className="mt-2 block text-xs text-muted">
          {card.latest.who ? t("mention.latestBy", { what: card.latest.what, who: card.latest.who }) : card.latest.what} {formatAgo(card.latest.at, locale)}
        </span>
      )}
    </span>
  );
}
