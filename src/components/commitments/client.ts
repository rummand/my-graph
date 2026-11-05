"use client";
/** Talking to /api/commitments from the browser. */
import type { CommitmentView, Party } from "@/lib/commitments/pure";
import type { LedgerData } from "@/lib/commitments/ledger";

export type Action =
  | { action: "done"; note?: string; evidenceSourceId?: string }
  | { action: "reopen" }
  | { action: "snooze"; until: string }
  | { action: "progress"; note?: string }
  | { action: "reassign"; personId: string }
  | { action: "edit"; label?: string; dueAt?: string | null; amount?: { value: number; currency: string } | null; consequence?: string | null; leadDays?: number | null }
  | { action: "cancel"; reason?: "not_mine" | "not_a_commitment" | "duplicate" | "cancelled"; note?: string };

export type ActResult = { status: "delivered" | "proposed"; changeSetId: string; error?: string; nextProposalId?: string | null; commitment: CommitmentView | null };

export class ActError extends Error {}

export async function act(id: string, a: Action): Promise<ActResult> {
  const res = await fetch(`/api/commitments/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ActError(typeof data.error === "string" ? data.error : "");
  return data as ActResult;
}

export async function fetchLedger(): Promise<LedgerData> {
  const res = await fetch("/api/commitments", { cache: "no-store" });
  if (!res.ok) throw new ActError("");
  return (await res.json()).ledger as LedgerData;
}

export async function fetchPerson(personId: string): Promise<CommitmentView[]> {
  const res = await fetch(`/api/commitments?person=${encodeURIComponent(personId)}&status=open`, { cache: "no-store" });
  if (!res.ok) throw new ActError("");
  return (await res.json()).items as CommitmentView[];
}

export type { CommitmentView, Party, LedgerData };
