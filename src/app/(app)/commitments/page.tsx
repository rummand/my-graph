import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { loadLedger, waitingProposals } from "@/lib/commitments";
import { getLocale, getPrefs, getT } from "@/lib/i18n";
import { scopeOf } from "@/lib/graphs/pure";
import { WaitingCommitments } from "@/components/commitments/waiting";
import { CommitmentsLedger } from "@/components/commitments/ledger";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("commitments.meta.title") };
}

/**
 * Commitments: what the household owes, is owed and was promised. Proposals of new ones wait at the top (nothing is
 * on the list until a person delivers it); the list itself is the client ledger.
 */
export default async function CommitmentsPage() {
  const v = await requireUser();
  const [{ timeZone }, t, locale] = await Promise.all([getPrefs(), getT(), getLocale()]);
  const [ledger, waiting] = await Promise.all([loadLedger(v, { tz: timeZone }), waitingProposals(v, 20)]);
  const canDeliver = scopeOf(v).canWrite && v.role !== "guest";
  const lead = v.graphKind === "family" ? t("commitments.leadFamily") : t("commitments.lead", { graph: v.graphName });
  return (
    <CommitmentsLedger initial={ledger} lead={lead}
      waiting={waiting.length ? <WaitingCommitments sets={waiting.slice(0, 3)} total={waiting.length} t={t} locale={locale} tz={timeZone} canDeliver={canDeliver} /> : null} />
  );
}
