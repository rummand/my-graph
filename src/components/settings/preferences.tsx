"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { LOCALE_NAMES, LOCALES, themeAttribute, type Locale, type Theme } from "@/lib/i18n/core";
import { formatDate, isTimeZone, timeZoneChoices } from "@/lib/i18n/dates";
import { useLocale, useT } from "@/lib/i18n/client";
import { ErrorNote, Notice } from "@/app/login/notes";

type Prefs = { locale?: Locale; theme?: Theme; timeZone?: string };

async function save(p: Prefs) {
  await api("/api/settings", { method: "PATCH", json: p });
}

/** Put the chosen theme on <html> straight away (the server renders it from then on). */
export function applyTheme(theme: Theme) {
  const attr = themeAttribute(theme);
  if (attr) document.documentElement.dataset.theme = attr;
  else delete document.documentElement.dataset.theme;
}

/** A row of large radio options: real radios underneath, so arrows and screen readers work. */
function Choice<T extends string>({ name, label, value, options, onChange, disabled }: {
  name: string; label: string; value: T; disabled?: boolean;
  options: { value: T; title: ReactNode; hint?: ReactNode; icon?: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label key={o.value}
              className={clsx("relative flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                on ? "bg-bg ring-1 ring-inset ring-fg" : "bg-surface-2/60 hover:bg-surface-2")}>
              <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
              {o.icon && <span className="shrink-0 text-muted" aria-hidden>{o.icon}</span>}
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block font-medium">{o.title}</span>
                {o.hint && <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>}
              </span>
              {on && <Check size={16} className="shrink-0" aria-hidden />}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function LanguageChoice() {
  const router = useRouter();
  const t = useT();
  const current = useLocale();
  const [value, setValue] = useState<Locale>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(current), [current]);

  async function choose(l: Locale) {
    if (l === value) return;
    const before = value;
    setValue(l); setBusy(true); setError(null);
    try {
      await save({ locale: l });
      document.documentElement.lang = l;
      router.refresh();
    } catch (e) {
      setValue(before); setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Choice name="locale" label={t("settings.language.title")} value={value} onChange={choose} disabled={busy}
        options={LOCALES.map((l) => {
          // Each language is named in itself; in the reader's own language underneath when that differs.
          const inYours = t(`settings.language.names.${l}`);
          return { value: l, title: <span lang={l}>{LOCALE_NAMES[l]}</span>, hint: inYours !== LOCALE_NAMES[l] ? inYours : undefined };
        })} />
      <p className="mt-3 text-sm text-muted">{t("settings.language.note")}</p>
      <ErrorNote message={error} className="mt-3" />
    </div>
  );
}

export function ThemeChoice({ initial }: { initial: Theme }) {
  const t = useT();
  const [value, setValue] = useState<Theme>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function choose(th: Theme) {
    const before = value;
    setValue(th); setError(null); setSaved(false);
    applyTheme(th);
    try {
      await save({ theme: th });
      setSaved(true);
    } catch (e) {
      setValue(before); applyTheme(before); setError(errorMessage(e));
    }
  }

  return (
    <div>
      <Choice name="theme" label={t("settings.appearance.title")} value={value} onChange={choose}
        options={[
          { value: "system", title: t("settings.appearance.system"), hint: t("settings.appearance.systemHint"), icon: <Monitor size={18} /> },
          { value: "light", title: t("settings.appearance.light"), icon: <Sun size={18} /> },
          { value: "dark", title: t("settings.appearance.dark"), icon: <Moon size={18} /> },
        ]} />
      <ErrorNote message={error} className="mt-3" />
      {saved && <Notice message={t("settings.appearance.saved")} className="mt-3" />}
    </div>
  );
}

export function TimeZoneChoice({ initial }: { initial: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [device, setDevice] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const zones = useMemo(() => {
    const all = timeZoneChoices();
    return all.includes(value) ? all : [value, ...all];
  }, [value]);

  useEffect(() => {
    // Read on the client only: the server doesn't know this device's zone, and the clock would not match.
    try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (isTimeZone(z)) setDevice(z); } catch { /* none */ }
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  async function choose(z: string) {
    const before = value;
    setValue(z); setError(null); setSaved(false);
    try {
      await save({ timeZone: z });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setValue(before); setError(errorMessage(e));
    }
  }

  return (
    <div>
      <label htmlFor="tz" className="mb-1.5 block text-sm font-medium">{t("settings.timeZone.label")}</label>
      <Select id="tz" value={value} onChange={(e) => void choose(e.target.value)} className="w-full sm:max-w-sm">
        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
      </Select>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted" suppressHydrationWarning>
          {now ? t("settings.timeZone.now", { time: formatDate(now, "time", { locale, timeZone: value }) }) : " "}
        </p>
        {device && device !== value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void choose(device)}>
            {t("settings.timeZone.useDevice", { zone: device.replace(/_/g, " ") })}
          </Button>
        )}
      </div>
      <ErrorNote message={error} className="mt-3" />
      {saved && <Notice message={t("settings.timeZone.saved")} className="mt-2" />}
    </div>
  );
}
