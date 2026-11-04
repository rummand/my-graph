import Link from "next/link";
import { PlugZap } from "lucide-react";
import { getT } from "@/lib/i18n";
import { TodaySection } from "./section";

/** Connections (Aula calendar, a mailbox …) that stopped until the person fixes them: one line each, linking to the fix. */
export async function ConnectionsNeedYou({ items }: { items: { id: string; label: string; detail: string | null }[] }) {
  if (!items.length) return null;
  const t = await getT();
  return (
    <TodaySection id="connections" title={t("today.connections.title")}>
      <ul className="space-y-2">
        {items.map((c) => (
          <li key={c.id}>
            <Link href={`/connections/${c.id}`} className="group flex items-start gap-3 rounded-lg bg-warn-tint px-4 py-3 transition-colors hover:bg-warn-tint/70">
              <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium group-hover:underline">{t("today.connections.line", { name: c.label })}</span>
                {c.detail && <span className="block text-sm text-muted">{c.detail}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </TodaySection>
  );
}
