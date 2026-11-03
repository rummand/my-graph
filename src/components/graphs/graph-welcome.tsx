import Link from "next/link";
import type { CSSProperties } from "react";
import { FolderOpen, MessageCircle, UserPlus } from "lucide-react";
import type { Viewer } from "@/lib/auth";
import { buttonClass } from "@/components/ui";
import { GraphDot } from "./bits";
import { isNewGraph, loadGraphViews } from "./data";
import { firstName, graphStyle, ownerOf } from "./describe";
import { SwitchButton } from "./switch-button";

/**
 * Shown only while the current graph is brand new (not the family graph, nothing added yet).
 * `full` (Today): what the graph is and the three first things to do. Otherwise one line pointing at graphs others
 * shared with you, so someone who lands in their empty Personal graph finds the one that was made for them.
 */
export async function GraphWelcome({ viewer, full = false }: { viewer: Viewer; full?: boolean }) {
  if (viewer.graphKind === "family") return null;
  const [fresh, graphs] = await Promise.all([isNewGraph(viewer).catch(() => false), loadGraphViews(viewer).catch(() => [])]);
  if (!fresh) return null;
  const current = graphs.find((g) => g.isCurrent);
  if (!current) return null;
  const fromOthers = graphs.filter((g) => !g.isCurrent && !g.isFamily && g.myRole !== "owner");
  const elsewhere = fromOthers[0];
  const owner = elsewhere ? ownerOf(elsewhere) : null;
  const canWrite = viewer.graphRole !== "viewer";

  const pointer = elsewhere && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-[15px]">
        <GraphDot hue={elsewhere.color} className="mr-2 align-[1px]" />Looking for <span className="font-medium">{elsewhere.name}</span>? {owner ? `${firstName(owner.name)} shared it with you.` : "It was shared with you."}
      </p>
      <SwitchButton graphId={elsewhere.id}>Open {elsewhere.name}</SwitchButton>
    </div>
  );

  if (!full) {
    return pointer ? <div className="mb-6 rounded-lg bg-surface px-4 py-3">{pointer}</div> : null;
  }

  return (
    <section aria-labelledby="graph-welcome" className="mb-8 rounded-lg bg-[var(--g-tint)] p-5 sm:p-6" style={graphStyle(current.color) as CSSProperties}>
      <div className="flex items-center gap-2.5">
        <GraphDot hue={current.color} size={12} />
        <h2 id="graph-welcome" className="text-lg font-semibold tracking-[-0.01em]">{current.name} is empty so far</h2>
      </div>
      <p className="mt-1.5 max-w-[62ch] text-muted">
        {canWrite
          ? "Start it with a letter or a photo, a person, or a question. Nothing from your other graphs shows up here."
          : "Nothing has been added yet. What the owner adds will show up here."}
      </p>
      {canWrite && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/library" className={buttonClass("primary")}><FolderOpen size={16} aria-hidden /> Upload a file</Link>
          <Link href="/people/new" className={buttonClass("secondary")}><UserPlus size={16} aria-hidden /> Add a person</Link>
          <Link href="/chat" className={buttonClass("secondary")}><MessageCircle size={16} aria-hidden /> Ask a question</Link>
          {current.myRole === "owner" && current.kind === "shared" && current.members.length < 2 && (
            <Link href={`/graphs?g=${current.id}&invite=1`} className={buttonClass("ghost")}>Invite who it&apos;s for</Link>
          )}
        </div>
      )}
      {pointer && <div className="mt-5 border-t border-[color-mix(in_oklab,var(--g)_25%,transparent)] pt-4">{pointer}</div>}
    </section>
  );
}
