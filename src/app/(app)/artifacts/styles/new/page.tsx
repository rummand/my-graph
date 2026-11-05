import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesignSetEditor } from "@/components/artifacts/design-set-editor";
import { requireUser } from "@/lib/auth";
import { builtinSet, canEditDesignSets, getDesignSet, isBuiltinId } from "@/lib/design-sets";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("artifacts.setEditor.newTitle") };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** ?from=<built-in or own set> starts from a copy; ?site=1 opens "From a website". */
export default async function NewDesignSetPage({ searchParams }: Props) {
  const v = await requireUser();
  if (!canEditDesignSets(v)) notFound();
  const sp = await searchParams;
  const from = typeof sp.from === "string" ? sp.from : "mygraph";
  const base = (isBuiltinId(from) ? builtinSet(from) : await getDesignSet(v, from)) ?? builtinSet("mygraph");
  return (
    <DesignSetEditor canEdit graphName={v.graphName} openSite={sp.site === "1"}
      initial={{ id: null, name: base.name, description: base.description ?? "", tokens: base.tokens, templates: base.templates, builtin: true, version: 1 }} />
  );
}
