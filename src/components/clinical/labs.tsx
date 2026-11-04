"use client";
/** Lab values: read from an uploaded result (proposals to confirm, each with its line), and each analyte's trend. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { ItemView } from "@/lib/clinical/items";
import { call } from "./api";
import { DocPicker } from "./doc-picker";
import { ItemCard } from "./item-card";
import { TrendChart } from "./trend-chart";

export function Labs({ clientId, items, canWrite, allowed }: { clientId: string; items: ItemView[]; canWrite: boolean; allowed: boolean }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const labs = items.filter((i) => i.kind === "lab");
  const proposed = labs.filter((l) => l.status === "proposed");
  const confirmed = labs.filter((l) => l.status === "confirmed" && l.value != null);
  const groups = [...new Set(confirmed.map((l) => l.title ?? ""))].map((name) => ({ name, rows: confirmed.filter((l) => l.title === name) }));
  return (
    <div className="space-y-4">
      {labs.length === 0 && <p className="text-sm text-muted">{t("clinical.labs.none")}</p>}
      {proposed.length > 0 && (
        <ul className="space-y-2">
          {proposed.map((l) => (
            <ItemCard key={l.id} item={l} canDecide={canWrite} title={`${l.title} ${l.value}${l.unit ? ` ${l.unit}` : ""}`}
              detail={[l.refLow != null || l.refHigh != null ? t("clinical.labs.range", { low: l.refLow ?? "", high: l.refHigh ?? "" }) : null, l.flag && l.flag !== "normal" ? t(`clinical.labs.flag.${l.flag}`) : null, l.measuredAt ? fmt(l.measuredAt) : null].filter(Boolean).join(", ")} />
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map((g) => {
            const last = g.rows[0];
            return (
              <div key={g.name}>
                <p className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{g.name}</span>
                  {last.flag && last.flag !== "normal" && <span className={clsx(last.flag === "high" ? "text-warn" : "text-warn")}>{t(`clinical.labs.flag.${last.flag}`)}</span>}
                </p>
                <TrendChart label={g.name} unit={last.unit} low={last.refLow} high={last.refHigh} points={g.rows.map((r) => ({ at: r.measuredAt ?? r.createdAt, value: r.value! }))} />
                {(last.refLow != null || last.refHigh != null) && <p className="mt-0.5 text-xs text-muted">{t("clinical.labs.range", { low: last.refLow ?? "", high: last.refHigh ?? "" })}{last.unit ? ` ${last.unit}` : ""}</p>}
              </div>
            );
          })}
        </div>
      )}
      {canWrite && allowed && !open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><FlaskConical aria-hidden className="size-4" />{t("clinical.labs.import")}</Button>}
      {open && (
        <div className="space-y-3 rounded-lg bg-surface p-4">
          <p className="text-sm font-medium">{t("clinical.labs.pick")}</p>
          <DocPicker value={doc} onChange={setDoc} label={t("clinical.labs.pick")} />
          {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
          <div className="flex gap-2">
            <Button disabled={!doc || busy} onClick={async () => {
              setBusy(true); setMsg(null);
              const r = await call<{ added: number }>(`/api/clinical/clients/${clientId}/labs`, { body: { sourceId: doc } }, t("clinical.err.offline"));
              setBusy(false);
              if (r.error) { setMsg(r.error); return; }
              setMsg(r.data!.added ? t("clinical.labs.added", { count: r.data!.added }) : t("clinical.labs.noneFound"));
              router.refresh();
            }}>{busy ? t("clinical.labs.reading") : t("clinical.labs.import")}</Button>
            <Button variant="ghost" onClick={() => { setOpen(false); setMsg(null); }}>{t("clinical.consent.cancel")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
