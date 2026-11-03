import { clsx } from "clsx";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/ui";
import { graphStyle, type GraphPerson } from "./describe";

/** A graph's colour as a dot. */
export function GraphDot({ hue, size = 10, className }: { hue: number; size?: number; className?: string }) {
  return (
    <span aria-hidden className={clsx("inline-block shrink-0 rounded-full bg-[var(--g)]", className)}
      style={{ ...graphStyle(hue), width: size, height: size } as CSSProperties} />
  );
}

/** The people in a graph as overlapping avatars, at most `max`, then "+N". */
export function MemberStack({ people, max = 3, size = 20, className }: { people: GraphPerson[]; max?: number; size?: number; className?: string }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className={clsx("flex shrink-0 items-center gap-0.5", className)} title={people.map((p) => p.name).join(", ")}>
      {shown.map((p) => <Avatar key={p.userId} id={p.colorId} name={p.name} size={size} />)}
      {extra > 0 && <span className="ml-1 text-xs tabular-nums text-muted">+{extra}</span>}
    </span>
  );
}
