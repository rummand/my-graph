/**
 * The app side of the work connectors (server-only): an API signed with a token or a sign-in, the provider base URLs,
 * and handing a batch to importPayload (kept as a library source of the connection, read by its importer, which
 * proposes one change set). The sync modules import only the WorkDeps type, so they stay testable without a database.
 */
import { guardedTransport } from "@/lib/mcp-client/transport";
import { encodeWork } from "@/lib/importers/github/work";
import { importPayload } from "@/lib/importers/server";
import type { Api } from "../oauth/client";
import { apiBase } from "../oauth/providers";
import { apiFor } from "../oauth/session";
import type { RunContext } from "../types";
import { keyApi, type WorkDeps } from "./work";

type Vis = "private" | "parents" | "household";

export function workDeps(api: Api): WorkDeps {
  const base = apiBase();
  return {
    api,
    base: { github: base.github, linear: base.linear },
    importBatch: (ctx, importer, batch, o) => importPayload(ctx.viewer, importer, {
      bytes: encodeWork(batch), title: o.title, connectionId: ctx.connection.id, externalId: o.externalId,
      visibility: ((ctx.config as { visibility?: Vis }).visibility) ?? "private",
    }),
  };
}

/** A run signed with the connection's OAuth sign-in (refreshed as needed). */
export function signedInDeps(ctx: RunContext<unknown>): WorkDeps {
  return workDeps(apiFor(ctx.connection, ctx.secrets, { signal: ctx.signal, throttle: ctx.throttle }));
}

/** A run signed with a saved token or key, sent as this Authorization header. */
export function keyDeps(ctx: RunContext<unknown>, authorization: string, who: string): WorkDeps {
  return workDeps(keyApi({ transport: guardedTransport(), authorization, who, signal: ctx.signal, throttle: ctx.throttle }));
}
