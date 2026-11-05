import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { getT } from "@/lib/i18n";

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="max-w-3xl">
      <EmptyState title={t("wiki.notFound.title")}>
        <p>{t("wiki.notFound.body")}</p>
        <Link href="/wiki" className="mt-3 inline-block font-medium text-accent hover:underline">{t("wiki.newPage.backToWiki")}</Link>
      </EmptyState>
    </div>
  );
}
