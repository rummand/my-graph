import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { NewPageForm } from "@/components/wiki/new-page-form";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";

export const metadata: Metadata = { title: "New page · Wiki · My Graph" };

export default async function NewWikiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const raw = await searchParams;
  const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : "";
  if (v.role === "guest" || !scopeOf(v).canWrite) {
    return (
      <div className="max-w-3xl">
        <EmptyState title="You can't add pages here">
          <p>{v.role === "guest" ? "Ask someone in the family to write it, or to share it with you." : "You can read this graph but not add to it. Ask its owner to make you an editor."}</p>
          <Link href="/wiki" className="mt-3 inline-block text-accent hover:underline">Back to the wiki</Link>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="max-w-[820px]">
      <Link href="/wiki" className="-ml-2 mb-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />Wiki
      </Link>
      <NewPageForm initialTitle={title} />
    </div>
  );
}
