import Link from "next/link";
import { Search } from "lucide-react";
import { Button, Input } from "@/components/ui";

/** A plain GET search (works without JavaScript); the page reads ?q=. */
export function SearchForm({ action, q, placeholder, submit, clear, label }: {
  action: string; q?: string; placeholder: string; submit: string; clear: string; label: string;
}) {
  return (
    <form action={action} method="get" role="search" className="mb-5 flex flex-wrap items-center gap-2">
      <label className="relative min-w-0 flex-1 sm:max-w-sm">
        <span className="sr-only">{label}</span>
        <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input name="q" type="search" defaultValue={q} placeholder={placeholder} className="pl-9" maxLength={200} />
      </label>
      <Button type="submit" variant="secondary">{submit}</Button>
      {q && <Link href={action} className="text-sm text-muted hover:text-fg">{clear}</Link>}
    </form>
  );
}
