import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { NewPageForm } from "@/components/wiki/new-page-form";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "New page · Wiki · My Graph" };

export default async function NewWikiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const raw = await searchParams;
  const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : "";
  if (v.role === "guest") {
    return (
      <div className="max-w-3xl">
        <EmptyState title="Guests can't create pages">
          <p>Ask someone in the family to write it, or to share it with you.</p>
          <Link href="/" className="mt-3 inline-block text-accent hover:underline">Back to Today</Link>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="max-w-3xl">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href="/wiki" className="hover:text-fg hover:underline">Wiki</Link><span aria-hidden> / </span><span className="text-fg">New page</span>
      </nav>
      <PageHeader title="New page" lead="Give it a title and choose who can see it. You'll write the rest in the editor." />
      <NewPageForm initialTitle={title} />
    </div>
  );
}
