"use client";
import { Input, Textarea } from "@/components/ui";
import type { MetaAttribute } from "@/lib/meta/types";

const PLACEHOLDER: Partial<Record<MetaAttribute["dataType"], string>> = {
  phone: "+45 12 34 56 78", email: "name@example.dk", url: "https://", date: "",
};

/** One input generated from a meta-model attribute. Value is kept as a string (or boolean) in the form. */
export function AttributeField({ attr, value, onChange, error, disabled, idPrefix = "attr" }: {
  attr: MetaAttribute; value: unknown; onChange: (v: unknown) => void; error?: string; disabled?: boolean; idPrefix?: string;
}) {
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
        <select {...common} value={str} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm">
          <option value="">—</option>
          {attr.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "date":
      // Year-less birthdays (--MM-DD) stay editable as text.
      control = str.startsWith("--")
        ? <Input {...common} value={str} onChange={(e) => onChange(e.target.value)} placeholder="--MM-DD" />
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
      <label htmlFor={id} className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
        {attr.label}{attr.required && <span aria-hidden="true">*</span>}
        {attr.sensitive && <span className="rounded bg-surface-2 px-1 py-px text-[10px] font-normal">Parents only</span>}
      </label>
      {control}
      {error && <p id={`${id}-err`} className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Display form of a stored value. */
export function formatAttr(attr: MetaAttribute, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (attr.dataType === "boolean") return v === true || v === "true" ? "Yes" : "No";
  if (attr.dataType === "date" && typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    const n = /^--(\d{2})-(\d{2})$/.exec(v);
    if (n) return new Date(2000, +n[1] - 1, +n[2]).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  }
  return String(v);
}
