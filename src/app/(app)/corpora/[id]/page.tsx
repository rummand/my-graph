import { redirect } from "next/navigation";

/** An old /corpora/<id> link opens the rule set at /rules/<id>. */
export default async function CorpusRedirect({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/rules/${encodeURIComponent((await params).id)}`);
}
