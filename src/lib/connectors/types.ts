/** Shared connector types (no runtime code). */
import type { db } from "@/db";
import type { connections } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import type { Manifest } from "./manifest";
import type { ConnectionState } from "./state";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ConnectionRow = typeof connections.$inferSelect;

export type CountKey = "fetched" | "added" | "updated" | "unchanged" | "skipped" | "cancelled" | "proposed";
export type StreamCounts = Partial<Record<CountKey, number>>;

/** What a connector's sync gets: the person it runs as, its settings, and the only way to store things. */
export type RunContext<C = Record<string, unknown>> = {
  viewer: Viewer;
  connection: Pick<ConnectionRow, "id" | "graphId" | "userId" | "label" | "connector">;
  runId: string;
  config: C;
  /** Decrypted for this run only. Never log them, never put them in a source, never send them to mux. */
  secrets: Record<string, string>;
  now: Date;
  signal: AbortSignal;
  state(): ConnectionState;
  /** Write what a stream brought in and move its cursor, in one transaction. */
  commit(stream: string, cursor: unknown, write: (tx: Tx) => Promise<void>): Promise<void>;
  count(stream: string, key: CountKey, n?: number): void;
  log(line: string): void;
  /** Remember a change set this run opened (shown on the run and in "waiting for you"). */
  proposed(changeSetId: string | null | undefined): void;
  /** Wait so the connector stays under its manifest's rate limit. */
  throttle(): Promise<void>;
};

export type Connector<C = Record<string, unknown>> = {
  manifest: Manifest;
  /** Checks a person can be told about before saving (bad URL, private host). Throws a needs-you ConnectorError. */
  check?(config: C, secrets: Record<string, string>): Promise<void> | void;
  /** Non-secret facts worth showing (the feed's host name), saved into config when the connection is made. */
  describe?(config: C, secrets: Record<string, string>): Record<string, unknown>;
  sync?(ctx: RunContext<C>): Promise<void>;
};
