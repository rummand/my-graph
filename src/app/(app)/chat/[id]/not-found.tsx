import Link from "next/link";
import { EmptyState, buttonClass } from "@/components/ui";
import { getT } from "@/lib/i18n";

export default async function ConversationNotFound() {
  const t = await getT();
  return (
    <div className="mx-auto max-w-xl py-16">
      <EmptyState title={t("chat.notFound.title")}
        action={<Link href="/chat" className={buttonClass("primary")}>{t("chat.notFound.start")}</Link>}>
        <p>{t("chat.notFound.body")}</p>
      </EmptyState>
    </div>
  );
}
