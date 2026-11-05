"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui";

export type SearchFormValues = { q: string; types: string; owner: string; from: string; to: string; folder: string; sort: string };

const field = "h-9 rounded-md bg-surface px-2.5 text-sm ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent";

/** The /search form: the query and its filters. Changing a filter searches again; the URL holds the state. */
export function SearchForm({ values, folders, showFolder }: { values: SearchFormValues; folders: { id: string; label: string }[]; showFolder: boolean }) {
  const t = useT();
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);

  function submit() {
    const f = form.current;
    if (!f) return;
    const data = new FormData(f);
    const params = new URLSearchParams();
    for (const [k, v] of data.entries()) if (typeof v === "string" && v.trim() && !(k === "sort" && v === "relevance")) params.set(k, v.trim());
    router.push(`/search?${params.toString()}`);
  }

  return (
    <form ref={form} role="search" onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
      <input type="hidden" name="types" value={values.types} />
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-muted" aria-hidden />
        <input name="q" defaultValue={values.q} aria-label={t("search.label")} placeholder={t("search.placeholder")} autoComplete="off" spellCheck={false}
          className="h-12 w-full rounded-lg bg-surface pl-10 pr-28 text-[17px] ring-1 ring-inset ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent" />
        <Button type="submit" size="sm" className="absolute right-2 top-1/2 -translate-y-1/2">{t("search.page.apply")}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("search.page.owner")}</span>
          <select name="owner" defaultValue={values.owner} onChange={submit} className={field}>
            <option value="">{t("search.page.ownerAny")}</option>
            <option value="me">{t("search.page.ownerMe")}</option>
            <option value="others">{t("search.page.ownerOthers")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("search.page.from")}</span>
          <input type="date" name="from" defaultValue={values.from} onChange={submit} className={`${field} tabular-nums`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("search.page.to")}</span>
          <input type="date" name="to" defaultValue={values.to} onChange={submit} className={`${field} tabular-nums`} />
        </label>
        {showFolder && folders.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t("search.page.folder")}</span>
            <select name="folder" defaultValue={values.folder} onChange={submit} className={`${field} max-w-[220px]`}>
              <option value="">{t("search.page.folderAny")}</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("search.page.sort")}</span>
          <select name="sort" defaultValue={values.sort} onChange={submit} className={field}>
            <option value="relevance">{t("search.page.relevance")}</option>
            <option value="newest">{t("search.page.newest")}</option>
          </select>
        </label>
      </div>
    </form>
  );
}
