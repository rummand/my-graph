/** Notion connector (server-only), through the household's own public Notion integration. */
import type { Connector } from "../types";
import { apiBase } from "../oauth/providers";
import { apiFor } from "../oauth/session";
import { requireSignIn } from "../oauth/fields";
import { importerFor } from "../slack";
import { notionManifest, syncNotion, type NotionConfig } from "./connector";

export const notionConnector: Connector<NotionConfig> = {
  manifest: notionManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncNotion(ctx, {
    api: apiFor(ctx.connection, ctx.secrets, { signal: ctx.signal, throttle: ctx.throttle }),
    base: apiBase().notion,
    importBatch: importerFor(ctx, "notion"),
  }),
};
