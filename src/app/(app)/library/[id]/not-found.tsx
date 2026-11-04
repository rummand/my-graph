import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getT } from "@/lib/i18n";

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="max-w-xl pt-6">
      <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("library.notFound.title")}</h1>
      <p className="mt-2 text-muted">{t("library.notFound.body")}</p>
      <Link href="/library" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
        <ArrowLeft aria-hidden className="size-4" />{t("library.notFound.back")}
      </Link>
    </div>
  );
}
