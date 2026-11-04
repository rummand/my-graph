import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PersonProfileView } from "@/components/people/person-profile";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { personProfile } from "@/lib/people";
import { getNode, isRetired } from "@/lib/gbrain";

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
  return (
    <div className="mx-auto max-w-6xl">
      <PersonProfileView initial={profile} />
    </div>
  );
}
