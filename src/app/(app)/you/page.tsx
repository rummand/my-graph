import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getLocale, getT } from "@/lib/i18n";
import { readYou } from "@/lib/you";
import { YouBoard } from "@/components/you/you-board";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("you.metaTitle") };
}

/** "You": patterns in the signed-in person's own weeks. Only ever their own; there is no way to open someone else's. */
export default async function YouPage() {
  const v = await requireUser();
  if (v.role === "guest") notFound();
  const view = await readYou(v, { locale: await getLocale() });
  return <YouBoard initial={view} graphName={v.graphName} />;
}
