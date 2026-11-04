"use client";
import { Badge, Input, Select, Textarea } from "@/components/ui";
import type { MetaAttribute } from "@/lib/meta/types";
import { useT } from "@/lib/i18n/client";
import { INTL_TAG, type Locale, type TFn } from "@/lib/i18n/core";
import { attrName } from "@/lib/people/words";

const PLACEHOLDER: Partial<Record<MetaAttribute["dataType"], string>> = {
  phone: "+45 12 34 56 78", email: "name@example.dk", url: "https://", date: "",
};

/** One input generated from a meta-model attribute. Value is kept as a string (or boolean) in the form. */
export function AttributeField({ attr, value, onChange, error, disabled, idPrefix = "attr", family = true }: {
  attr: MetaAttribute; value: unknown; onChange: (v: unknown) => void; error?: string; disabled?: boolean; idPrefix?: string;
  /** Family rules: sensitive details are for parents; elsewhere for the owner and editors. */
  family?: boolean;
}) {
  const t = useT();
  const id = `${idPrefix}-${attr.key}`;
  const str = value === null || value === undefined ? "" : String(value);
  const describedBy = error ? `${id}-err` : undefined;
  const common = { id, disabled, "aria-invalid": !!error || undefined, "aria-describedby": describedBy };
  let control: React.ReactNode;
  switch (attr.dataType) {
    case "longtext":
      control = <Textarea {...common} rows={3} value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "boolean":
      control = (
        <input {...common} type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={value === true || value === "true"} onChange={(e) => onChange(e.target.checked)} />
      );
      break;
    case "enum":
      control = (
        <Select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("people.field.notSet")}</option>
          {attr.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      );
      break;
    case "date":
      // Year-less birthdays (--MM-DD) stay editable as text.
      control = str.startsWith("--")
        ? <Input {...common} value={str} onChange={(e) => onChange(e.target.value)} placeholder={t("people.field.monthDay")} />
        : <Input {...common} type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "number":
      control = <Input {...common} inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value)} />;
      break;
    default:
      control = <Input {...common} type={attr.dataType === "email" ? "email" : attr.dataType === "phone" ? "tel" : attr.dataType === "url" ? "url" : "text"}
        value={str} onChange={(e) => onChange(e.target.value)} placeholder={PLACEHOLDER[attr.dataType]} />;
  }
  return (
    <div className={attr.dataType === "longtext" ? "sm:col-span-2" : undefined}>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        {attrName(t, attr.label)}{attr.required && <span className="font-normal text-muted">{t("people.field.required")}</span>}
        {attr.sensitive && <Badge tone="warn">{t(family ? "people.field.parentsOnly" : "people.field.editorsOnly")}</Badge>}
      </label>
      {control}
      {error && <p id={`${id}-err`} className="mt-1.5 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

/** Display form of a stored value, in the reader's language ("9 November 2017" / "9. november 2017"). */
export function formatAttr(attr: MetaAttribute, v: unknown, t?: TFn, locale: Locale = "en"): string {
  if (v === null || v === undefined || v === "") return "";
  if (attr.dataType === "boolean") {
    const yes = v === true || v === "true";
    return t ? t(yes ? "people.field.yes" : "people.field.no") : yes ? "Yes" : "No";
  }
  if (attr.dataType === "date" && typeof v === "string") {
    // Calendar dates: formatted as that day in UTC so no time zone moves them.
    const fmt = (y: number, mo: number, d: number, withYear: boolean) => new Intl.DateTimeFormat(INTL_TAG[locale], {
      timeZone: "UTC", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}),
    }).format(new Date(Date.UTC(y, mo - 1, d, 12)));
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return fmt(+m[1], +m[2], +m[3], true);
    const n = /^--(\d{2})-(\d{2})$/.exec(v);
    if (n) return fmt(2000, +n[1], +n[2], false);
  }
  return String(v);
}
