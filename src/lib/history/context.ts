/**
 * Who is writing, and inside which transaction (server-only). `remembering()` and `deliverChangeSet()` run their write
 * inside this store; GBrain's writes read it to stamp their history with the right hand (a person, the assistant, a
 * proposal being delivered) and, during a delivery, to join the delivery's one transaction instead of opening their own.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { db } from "@/db";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Actor = { kind: "person" | "assistant" | "connector" | "import" | "system"; id: string | null; name: string | null };

export type HistoryScope = {
  graphId: string;
  actor: Actor;
  changeSetId: string | null;
  context: string | null;
  /** Set while a change set is delivered: every GBrain write joins this transaction (as a savepoint). */
  tx?: Tx;
  /** Work to run once the delivery committed (embeddings), so it never sees uncommitted rows. */
  afterCommit?: (() => void)[];
  /** An outer remembering() already watches the meta model; inner ones don't snapshot it again. */
  metaWatched?: boolean;
};

const g = globalThis as unknown as { __mgHistoryStore?: AsyncLocalStorage<HistoryScope> };
export const historyStore: AsyncLocalStorage<HistoryScope> = (g.__mgHistoryStore ??= new AsyncLocalStorage<HistoryScope>());

export function currentScope(): HistoryScope | undefined {
  return historyStore.getStore();
}

/** The delivery's transaction, when a write runs inside one. */
export function ambientTx(): Tx | undefined {
  return historyStore.getStore()?.tx;
}

/** Run now, or once the surrounding delivery has committed. */
export function afterCommit(fn: () => void): void {
  const s = historyStore.getStore();
  if (s?.tx && s.afterCommit) s.afterCommit.push(fn);
  else fn();
}
