import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BacklinksPanel } from "@/components/wiki/backlinks-panel";
import { WikiPageClient } from "@/components/wiki/page-client";
import { requireUser } from "@/lib/auth";
import { getBacklinks, getPage, type Backlinks } from "@/lib/wiki";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const SLUG = /^[a-z0-9-]{1,120}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG.test(slug)) return { title: "Not found · My Graph" };
  const v = await requireUser();
  const page = await getPage(v, slug);
  return { title: page ? `${page.title} · Wiki · My Graph` : "Not found · My Graph" };
}

export default async function WikiPageRoute({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const v = await requireUser();
  const page = await getPage(v, slug);
  if (!page) notFound();
  const sp = await searchParams;

  let backlinks: Backlinks | null = null;
  try {
    backlinks = await getBacklinks(v, page);
  } catch (e) {
    console.warn("[wiki] backlinks failed", e);
  }

  return (
    <WikiPageClient
      key={`${page.id}:${page.version}`}
      startEditing={sp.edit === "1" || sp.assist === "1"}
      startAsking={sp.assist === "1"}
      mentions={backlinks?.mentions}
      initial={{
        id: page.id, slug: page.slug, title: page.title, content: page.content, visibility: page.visibility, version: page.version,
        ownerName: page.ownerName, isOwner: page.ownerId === v.id, updatedAt: page.updatedAt.toISOString(),
        updatedByName: page.updatedByName, nodeId: page.nodeId, can: page.can,
      }}>
      {backlinks
        ? <BacklinksPanel backlinks={backlinks} />
        : <p className="text-muted">Links to and from this page couldn&apos;t be loaded right now.</p>}
    </WikiPageClient>
  );
}
