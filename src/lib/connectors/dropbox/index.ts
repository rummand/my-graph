/** Dropbox connector (server-only), with the household's own Dropbox app. */
import type { Connector } from "../types";
import { runDeps } from "../oauth/deps";
import { requireSignIn } from "../oauth/fields";
import { dropboxManifest, syncDropbox, type DropboxConfig } from "./connector";

export const dropboxConnector: Connector<DropboxConfig> = {
  manifest: dropboxManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncDropbox(ctx, runDeps(ctx)),
};
