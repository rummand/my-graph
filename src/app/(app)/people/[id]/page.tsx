import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PersonProfileView } from "@/components/people/person-profile";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { personProfile } from "@/lib/people";
import { getNode, isRetired } from "@/lib/gbrain";
import { loadProfile } from "@/lib/profile";
import { loadClient } from "@/lib/clinical";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export const dynamic = "force-dynamic";

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const v = await requireUser();
  return personProfile(v, id);
}

/** A retired person still opens by id: on their node page, which says they're retired and offers to restore them. */
async function retiredHere(id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const n = await getNode(await requireUser(), id).catch(() => null);
  return !!n && n.id === id && isRetired(n.props);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const p = await load((await params).id);
  return { title: p?.person.label ?? (await getT())("people.person") };
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await load((await params).id);
  if (!profile) {
    const id = (await params).id;
    if (await retiredHere(id)) redirect(`/node/${id}`);
    notFound();
  }
  const v = await requireUser();
  const living = await loadProfile(v, profile.person.id);
  // A client or patient's profile is the base of their clinical record: link back to it for those who may open it.
  const k = living.node.kind;
  const record = k === "client" || k === "patient" ? await loadClient(v, profile.person.id).catch(() => null) : null;
  const t = record ? await getT() : null;
  return (
    <div className="mx-auto max-w-6xl">
      {record && t && (
        <div className="mb-4 flex justify-end">
          <Link href={`/clinical/clients/${record.id}`} title={t("clinical.client.recordHint", { name: record.label })}
            className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            {t("clinical.client.record")}<ArrowUpRight aria-hidden className="size-4" />
          </Link>
        </div>
      )}
      <PersonProfileView initial={profile} living={living} />
    </div>
  );
}
