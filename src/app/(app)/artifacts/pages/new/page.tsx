import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { NewPageForm } from "@/components/pages/new-page-form";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("pages.meta.newPage") };
}

export default async function NewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const t = await getT();
  const family = v.graphKind === "family";
  const raw = await searchParams;
  const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : "";
  if (v.role === "guest" || !scopeOf(v).canWrite) {
    return (
      <div className="max-w-3xl">
        <EmptyState title={t("pages.newPage.cantAdd")}>
          <p>{v.role === "guest" ? t(family ? "pages.newPage.guestFamily" : "pages.newPage.guest") : t("pages.newPage.viewer")}</p>
          <Link href="/artifacts/pages" className="mt-3 inline-block text-accent hover:underline">{t("pages.newPage.backToPages")}</Link>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="max-w-[820px]">
      <Link href="/artifacts/pages" className="-ml-2 mb-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />{t("pages.newPage.back")}
      </Link>
      <NewPageForm initialTitle={title} family={family} />
    </div>
  );
}
