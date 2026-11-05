import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BacklinksPanel } from "@/components/pages/backlinks-panel";
import { PageClient } from "@/components/pages/page-client";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getBacklinks, getPage, type Backlinks } from "@/lib/pages";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const SLUG = /^[a-z0-9-]{1,120}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getT();
  if (!SLUG.test(slug)) return { title: t("pages.meta.notFound") };
  const v = await requireUser();
  const page = await getPage(v, slug);
  return { title: page ? t("pages.meta.page", { title: page.title }) : t("pages.meta.notFound") };
}

export default async function PageRoute({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const v = await requireUser();
  const page = await getPage(v, slug);
  if (!page) notFound();
  const sp = await searchParams;
  const t = await getT();

  let backlinks: Backlinks | null = null;
  try {
    backlinks = await getBacklinks(v, page);
  } catch (e) {
    console.warn("[pages] backlinks failed", e);
  }

  return (
    <PageClient
      key={`${page.id}:${page.version}`}
      startEditing={sp.edit === "1" || sp.assist === "1"}
      startAsking={sp.assist === "1"}
      mentions={backlinks?.mentions}
      family={v.graphKind === "family"}
      initial={{
        id: page.id, slug: page.slug, title: page.title, content: page.content, visibility: page.visibility, version: page.version,
        ownerName: page.ownerName, isOwner: page.ownerId === v.id, updatedAt: page.updatedAt.toISOString(),
        updatedByName: page.updatedByName, nodeId: page.nodeId, can: page.can,
      }}>
      {backlinks
        ? <BacklinksPanel backlinks={backlinks} />
        : <p className="text-muted">{t("pages.page.backlinksFailed")}</p>}
    </PageClient>
  );
}
