/** Microsoft 365 / Outlook.com connector (server-only), with the household's own Microsoft app. */
import type { Connector } from "../types";
import { runDeps } from "../oauth/deps";
import { requireSignIn } from "../oauth/fields";
import { microsoftManifest, syncMicrosoft, type MicrosoftConfig } from "./connector";

export const microsoftConnector: Connector<MicrosoftConfig> = {
  manifest: microsoftManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncMicrosoft(ctx, runDeps(ctx)),
};
