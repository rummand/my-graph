import Link from "next/link";
import { clsx } from "clsx";
import type { CSSProperties } from "react";
import { personStyle } from "@/lib/ui/person-color";
import { typeColor } from "@/components/mention/colors";

/**
 * The small mark that stands for a node everywhere in the graph screens: the same shape and colour it has on the
 * canvas. People are a dot in their own colour; places a rounded square, events a diamond, topics a dot and
 * documents a slim tab, each in its type colour.
 */
export function NodeMark({ id, type, size = 10, className }: { id: string; type: string; size?: number; className?: string }) {
  const style: CSSProperties = type === "person"
    ? { ...personStyle(id), background: "var(--person)", width: size, height: size } as CSSProperties
    : { background: typeColor(type), width: type === "document" || type === "source" ? size * 0.8 : size, height: size };
  return (
    <span aria-hidden style={style} className={clsx("inline-block shrink-0",
      type === "person" || type === "topic" ? "rounded-full" : "rounded-[2px]",
      type === "event" && "rotate-45 scale-[0.8]", className)} />
  );
}

/** A node as a quiet chip with its mark. Renders a button when given onClick, a link when given href. */
export function NodePill({ id, type, label, href, onClick, className }: {
  id: string; type: string; label: string; href?: string; onClick?: () => void; className?: string;
}) {
  const person = type === "person";
  const cls = clsx("inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pl-2 pr-2.5 text-sm transition-[background-color,filter] duration-150",
    person ? "font-medium" : "bg-surface-2 text-fg", (href || onClick) && (person ? "hover:brightness-95" : "hover:bg-line"), className);
  const style = person ? { ...personStyle(id), background: "var(--person-tint)", color: "var(--person-ink)" } as CSSProperties : undefined;
  const body = <><NodeMark id={id} type={type} size={7} /><span className="truncate">{label}</span></>;
  if (onClick) return <button type="button" onClick={onClick} className={cls} style={style}>{body}</button>;
  if (href) return <Link href={href} className={cls} style={style}>{body}</Link>;
  return <span className={cls} style={style}>{body}</span>;
}
