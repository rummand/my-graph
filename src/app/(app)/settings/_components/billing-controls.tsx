"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { ExternalLink } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { ErrorNote, Notice } from "@/app/login/notes";
import { useLocale, useT } from "@/lib/i18n/client";

type Interval = "month" | "year";
export type PlanOption = {
  key: string; name: string; description: string; current: boolean; buyable: boolean;
  prices: Partial<Record<Interval, { amount: number | null; currency: string | null }>>;
};

function money(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale === "da" ? "da-DK" : "en-GB", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Where Stripe sends people back to: say what happened, then tidy the address. */
export function CheckoutReturn() {
  const t = useT();
  const params = useSearchParams();
  const result = params.get("billing");
  const [shown] = useState(result);
  useEffect(() => {
    if (!result) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("billing");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [result]);
  if (shown === "success") return <Notice className="mb-4" message={t("settings.plan.billing.success")} />;
  if (shown === "cancelled") return <p role="status" className="mb-4 text-sm text-muted">{t("settings.plan.billing.cancelled")}</p>;
  return null;
}

/** The public plans, with monthly or yearly prices and a button to buy the ones this person may buy. */
export function PlanOptions({ options, intervals }: { options: PlanOption[]; intervals: Interval[] }) {
  const t = useT();
  const locale = useLocale();
  const [interval, setInterval] = useState<Interval>(intervals.includes("month") ? "month" : "year");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selling = options.some((o) => o.buyable);

  async function buy(plan: string) {
    setBusy(plan); setError(null);
    try {
      const r = await api<{ url: string }>("/api/billing/checkout", { json: { plan, interval } });
      window.location.assign(r.url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <>
      {selling && intervals.length > 1 && (
        <div role="radiogroup" aria-label={t("settings.plan.billing.billedAs")} className="mt-2 inline-flex rounded-md bg-surface-2 p-0.5">
          {intervals.map((iv) => (
            <button key={iv} type="button" role="radio" aria-checked={interval === iv} onClick={() => setInterval(iv)}
              className={clsx("rounded px-3 py-1 text-sm transition-colors", interval === iv ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-fg")}>
              {iv === "month" ? t("settings.plan.billing.monthly") : t("settings.plan.billing.yearly")}
            </button>
          ))}
        </div>
      )}
      <ul className="mt-2 divide-y divide-line">
        {options.map((p) => {
          const price = p.prices[interval];
          const label = price && price.amount !== null && price.currency
            ? t(interval === "month" ? "settings.plan.billing.perMonth" : "settings.plan.billing.perYear", { price: money(price.amount, price.currency, locale) })
            : null;
          const canBuyNow = p.buyable && !p.current && !!price;
          return (
            <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <span className={clsx("w-20 shrink-0", p.current ? "font-semibold" : "font-medium")}>{p.name}</span>
              <span className="min-w-0 flex-1 basis-48 text-sm text-muted">
                {p.description}
                {label && <span className="block text-fg tabular-nums">{label}</span>}
              </span>
              {p.current && <Badge tone="accent">{t("settings.plan.current")}</Badge>}
              {canBuyNow && (
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => buy(p.key)}>
                  {busy === p.key ? t("settings.plan.billing.opening") : t("settings.plan.billing.choose", { plan: p.name })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {selling && <p className="mt-3 text-sm text-muted">{t("settings.plan.billing.checkoutHint")}</p>}
      <ErrorNote className="mt-3" message={error} />
    </>
  );
}

/** Opens the Stripe Customer Portal. */
export function ManageSubscription() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ url: string }>("/api/billing/portal", { json: {} });
      window.location.assign(r.url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={open} disabled={busy}>
          <ExternalLink size={16} aria-hidden />{busy ? t("settings.plan.billing.opening") : t("settings.plan.billing.manage")}
        </Button>
        <p className="min-w-0 flex-1 basis-56 text-sm text-muted">{t("settings.plan.billing.manageHint")}</p>
      </div>
      <ErrorNote className="mt-3" message={error} />
    </div>
  );
}
