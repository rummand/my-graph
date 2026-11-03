import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PersonProfileView } from "@/components/people/person-profile";
import { requireUser } from "@/lib/auth";
import { personProfile } from "@/lib/people";

export const dynamic = "force-dynamic";

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const v = await requireUser();
  return personProfile(v, id);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const p = await load((await params).id);
  return { title: p?.person.label ?? "Person" };
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await load((await params).id);
  if (!profile) notFound();
  return (
    <div className="mx-auto max-w-6xl">
      <PersonProfileView initial={profile} />
    </div>
  );
}
