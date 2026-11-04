import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { getT } from "@/lib/i18n";

export default async function NodeNotFound() {
  const t = await getT();
  return (
    <EmptyState title={t("graph.node.notFoundTitle")}
      action={<Link href="/graph" className="text-sm text-accent hover:underline">{t("graph.node.backToGraph")}</Link>}>
      {t("graph.node.notFoundBody")}
    </EmptyState>
  );
}
