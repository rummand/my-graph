/** Rows for the Artifacts hub: one list item per page, document or deck (server component). */
import Link from "next/link";
import { Badge } from "@/components/ui";
import { MADE, type MadeItem } from "@/lib/artifacts/kinds";
import type { TFn } from "@/lib/i18n";
import { DOCUMENT_ICON, madeIcon } from "./kind-icon";

export function MadeRow({ item, t, ago, showKind = true }: { item: MadeItem; t: TFn; ago: (d: string) => string; showKind?: boolean }) {
  const Icon = item.subKind ? DOCUMENT_ICON[item.subKind] ?? madeIcon(MADE[item.kind].icon) : madeIcon(MADE[item.kind].icon);
  const kindLabel = item.subKind ? t(`artifacts.kinds.${item.subKind}`) : t(MADE[item.kind].label);
  const by = !item.isMine && item.ownerName ? ` ${t("artifacts.by", { name: item.ownerName })}` : "";
  return (
    <li>
      <Link href={item.href} className="group flex items-start gap-3 rounded-md px-2 py-3 hover:bg-surface-2/70">
        <Icon className="mt-0.5 size-[18px] shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-words font-medium group-hover:underline">{item.title}</span>
            {item.drafting && <Badge tone="accent">{t("artifacts.drafting")}</Badge>}
          </span>
          {item.excerpt && <span className="mt-0.5 line-clamp-1 block max-w-[68ch] text-sm text-muted">{item.excerpt}</span>}
          <span className="mt-0.5 block text-sm text-muted">
            {showKind ? `${kindLabel} · ` : ""}{t("artifacts.updated", { when: ago(item.updatedAt) })}{by}
          </span>
        </span>
        {item.status === "published" && <Badge tone="neutral">{t("artifacts.status.published")}</Badge>}
        {item.status === "draft" && item.isMine && <Badge tone="neutral">{t("artifacts.status.draft")}</Badge>}
      </Link>
    </li>
  );
}
