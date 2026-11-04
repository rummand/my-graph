import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PersonChip } from "@/components/ui";
import { MessageList } from "@/components/timeline/thread-section";
import { requireUser } from "@/lib/auth";
import { listNodes } from "@/lib/gbrain";
import { personMatcher } from "@/lib/timeline/documents";
import { loadThread } from "@/lib/timeline/threads";
import { formatSpan, senderName } from "@/components/library/i18n";
import { libraryLx } from "@/components/library/server-lx";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("library.threadMetaTitle") };
}
export const dynamic = "force-dynamic";

const emailIn = (s: string | null) => (s?.match(/<([^>]+)>/)?.[1] ?? s ?? "").toLowerCase().trim();
const nameIn = (s: string) => senderName(s) ?? s;

/** One mail conversation from the library, oldest message first, each with its source. */
export default async function ThreadPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const key = typeof raw.key === "string" ? raw.key.slice(0, 1000) : "";
  if (!key) notFound();
  const v = await requireUser();
  const [t, L] = await Promise.all([loadThread(v, { key }), libraryLx(v)]);
  if (!t) notFound();

  // Who is on it: matched to people in the graph by email address (or name).
  const people = await listNodes(v, { type: "person", limit: 500 }).catch(() => []);
  const match = personMatcher(people.map((p) => ({
    id: p.id, label: p.label, aliases: p.aliases,
    emails: [p.props?.email, ...(Array.isArray(p.props?.emails) ? p.props.emails : [])].filter((e): e is string => typeof e === "string"),
  })));
  const senders = new Map<string, { name: string; personId: string | null }>();
  for (const m of t.messages) {
    if (!m.from) continue;
    const email = emailIn(m.from);
    if (!senders.has(email)) senders.set(email, { name: nameIn(m.from), personId: match({ email, name: nameIn(m.from) }) });
  }
  const personByEmail = Object.fromEntries([...senders].filter(([, p]) => p.personId).map(([e, p]) => [e, p.personId!]));
  const first = t.messages[0]?.at, last = t.messages[t.messages.length - 1]?.at;

  return (
    <div className="max-w-3xl">
      <Link href="/library?type=mail" className="mb-5 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />{L.t("library.thread.back")}
      </Link>
      <header className="mb-8">
        <h1 className="break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t.subject}</h1>
        <p className="mt-2 text-sm text-muted">
          {L.t("library.count.messages", { count: t.messages.length })}
          {first ? `, ${formatSpan(L, String(first), last && last !== first ? String(last) : null)}` : ""}
        </p>
        {senders.size > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[...senders].map(([email, p]) => p.personId
              ? <PersonChip key={email} id={p.personId} name={p.name} href={`/people/${p.personId}`} />
              : <span key={email} title={email} className="inline-flex h-7 items-center rounded-full bg-surface-2 px-2.5 text-sm text-muted">{p.name}</span>)}
          </div>
        )}
      </header>
      <MessageList messages={t.messages} personByEmail={personByEmail} />
    </div>
  );
}
