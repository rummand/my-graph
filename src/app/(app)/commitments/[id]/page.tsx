import { redirect } from "next/navigation";

/** A commitment's page is its living profile in the graph (with the commitment panel on top). */
export default async function CommitmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(/^[0-9a-f-]{36}$/i.test(id) ? `/node/${id}` : "/commitments");
}
