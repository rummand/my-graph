/**
 * What a provider connector's sync works with: an authorised API, the sink that stores what it reads, and the
 * provider base URLs. The app builds them from the run (`runDeps`); the tests hand in a fake API and a memory sink.
 * Server-only (the sync modules import only the SyncDeps type, so they stay testable without a database).
 */
import type { Api } from "./client";
import { apiBase } from "./providers";
import { apiFor } from "./session";
import { dbSink, type Sink } from "./sink";
import type { RunContext } from "../types";

export type SyncDeps = { api: Api; sink: Sink; base: ReturnType<typeof apiBase> };

export function runDeps(ctx: RunContext<unknown>): SyncDeps {
  return {
    api: apiFor(ctx.connection, ctx.secrets, { signal: ctx.signal, throttle: ctx.throttle }),
    sink: dbSink,
    base: apiBase(),
  };
}
