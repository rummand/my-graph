import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ClinicalError } from "@/lib/clinical";
import { sessionPage } from "@/lib/clinical/views";
import { getT } from "@/lib/i18n";
import { SessionView } from "@/components/clinical/session-view";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const v = await requireUser();
  try {
    return await sessionPage(v, id);
  } catch (e) {
    if (e instanceof ClinicalError && e.status === 409) redirect("/clinical");
    if (e instanceof ClinicalError) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const t = await getT();
  const d = await load((await params).id).catch(() => null);
  return { title: `${d ? `${t(`clinical.kind.${d.session.kind}`)}: ${d.client.label}` : t("clinical.title")}` };
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  return <SessionView initial={await load((await params).id)} />;
}
