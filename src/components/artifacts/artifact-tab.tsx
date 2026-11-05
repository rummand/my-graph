/**
 * The Documents and Decks tabs of the Artifacts hub: the viewer's drafts, then what is published (server component).
 * Same list the old Documents page had, narrowed to one made kind.
 */
import Link from "next/link";
import { Presentation, ScrollText } from "lucide-react";
import { buttonClass, EmptyState, Section } from "@/components/ui";
import type { Viewer } from "@/lib/auth";
import { canMakeArtifacts } from "@/lib/artifacts";
import { MADE } from "@/lib/artifacts/kinds";
import { listMade } from "@/lib/artifacts/made";
import { formatAgo, getPrefs, getT } from "@/lib/i18n";
import { ArtifactsHubHeader } from "./hub";
import { MadeRow } from "./made-list";

export async function ArtifactTab({ v, kind }: { v: Viewer; kind: "document" | "deck" }) {
  const [t, prefs, list] = await Promise.all([getT(), getPrefs(), listMade(v, { kind })]);
  const ago = (d: string) => formatAgo(d, prefs.locale);
  const drafts = list.filter((a) => a.isMine && a.status === "draft");
  const published = list.filter((a) => a.status === "published");
  const canMake = canMakeArtifacts(v);
  const deck = kind === "deck";
  const Icon = deck ? Presentation : ScrollText;
  return (
    <div>
      <ArtifactsHubHeader v={v} t={t} active={kind} lead={t(deck ? "artifacts.hub.decksLead" : "artifacts.lead", { graph: v.graphName })} />
      <div className="max-w-4xl">
      {!list.length ? (
        <EmptyState title={t(deck ? "artifacts.hub.decksEmpty.title" : "artifacts.empty.title")} icon={<Icon className="size-6" />}
          action={canMake ? <Link href={MADE[kind].newHref} className={buttonClass("primary")}>{t(deck ? "artifacts.hub.decksEmpty.action" : "artifacts.empty.action")}</Link> : undefined}>
          {t(deck ? "artifacts.hub.decksEmpty.body" : "artifacts.empty.body")}
        </EmptyState>
      ) : (
        <div className="grid gap-10">
          {drafts.length > 0 && (
            <Section title={t("artifacts.mine")}><ul className="-mx-2">{drafts.map((a) => <MadeRow key={a.id} item={{ ...a, status: null }} t={t} ago={ago} />)}</ul></Section>
          )}
          {published.length > 0 && (
            <Section title={t("artifacts.published")}><ul className="-mx-2">{published.map((a) => <MadeRow key={a.id} item={{ ...a, status: null }} t={t} ago={ago} />)}</ul></Section>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
