import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Viewer } from "@/lib/auth";
import { todayCommitments } from "@/lib/commitments";
import { getT } from "@/lib/i18n";
import { scopeOf } from "@/lib/graphs/pure";
import { TodayCards } from "./today-cards";

/**
 * Today's line about commitments ("3 this week, 1 at risk", linking to the ledger) and the overdue / at-risk ones as
 * cards with Done. Nothing at all when the graph has no open commitments.
 */
export async function CommitmentsToday({ viewer, tz, now }: { viewer: Viewer; tz: string; now: Date }) {
  let data: Awaited<ReturnType<typeof todayCommitments>>;
  try {
    data = await todayCommitments(viewer, { now, tz, max: 3 });
  } catch (e) {
    console.error("[today] commitments failed:", e);
    return null;
  }
  const t = await getT();
  const { counts, urgent } = data;
  if (!counts.open) return null;
  const parts: { text: string; tone?: "warn" | "danger" }[] = [];
  if (counts.overdue) parts.push({ text: t("commitments.header.overdue", { count: counts.overdue }), tone: "danger" });
  parts.push({ text: t("commitments.header.thisWeek", { count: counts.thisWeek }) });
  if (counts.atRisk) parts.push({ text: t("commitments.header.atRisk", { count: counts.atRisk }), tone: "warn" });
  const calm = !counts.thisWeek && !counts.atRisk && !counts.overdue;
  return (
    <section aria-label={t("commitments.today.label")} className="mb-8">
      <Link href="/commitments" className="group inline-flex flex-wrap items-baseline gap-x-2 rounded text-[15px]">
        <span className="font-medium">{t("commitments.today.open")}</span>
        <span>
          {calm ? <span className="text-muted">{t("commitments.today.calm")}</span> : parts.map((p, i) => (
            <span key={i} className={p.tone === "danger" ? "font-medium text-danger" : p.tone === "warn" ? "font-medium text-warn" : "text-fg"}>{i > 0 ? ", " : ""}{p.text}</span>
          ))}
        </span>
        <ArrowRight aria-hidden className="size-4 self-center text-muted transition-transform group-hover:translate-x-0.5" />
      </Link>
      {urgent.length > 0 && <TodayCards items={urgent} tz={tz} nowIso={now.toISOString()} canWrite={scopeOf(viewer).canWrite && viewer.role !== "guest"} />}
    </section>
  );
}
