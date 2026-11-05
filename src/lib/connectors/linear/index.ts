/** Linear connectors (server-only): a personal API key, or "Sign in with Linear" (the household's own Linear app). */
import type { Connector } from "../types";
import { requireSignIn } from "../oauth/fields";
import { keyDeps, signedInDeps } from "../github/deps";
import { checkLinearKey, linearManifest, linearOAuthManifest, syncLinear, type LinearConfig } from "./connector";

export const linearConnector: Connector<LinearConfig> = {
  manifest: linearManifest,
  check: (_c, s) => checkLinearKey(s),
  // A personal API key goes in the Authorization header as it is (no "Bearer").
  sync: (ctx) => syncLinear(ctx, keyDeps(ctx, ctx.secrets.linearApiKey ?? "", "Linear")),
};

export const linearOAuthConnector: Connector<LinearConfig> = {
  manifest: linearOAuthManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncLinear(ctx, signedInDeps(ctx)),
};
