/** GitHub connectors (server-only): a fine-grained personal access token, or "Sign in with GitHub" (the household's own GitHub App). */
import type { Connector } from "../types";
import { requireSignIn } from "../oauth/fields";
import { checkGithubToken, githubManifest, githubOAuthManifest, syncGithub, type GithubConfig } from "./connector";
import { keyDeps, signedInDeps } from "./deps";

export const githubConnector: Connector<GithubConfig> = {
  manifest: githubManifest,
  check: (_c, s) => checkGithubToken(s),
  sync: (ctx) => syncGithub(ctx, keyDeps(ctx, `Bearer ${ctx.secrets.githubToken ?? ""}`, "GitHub")),
};

export const githubOAuthConnector: Connector<GithubConfig> = {
  manifest: githubOAuthManifest,
  check: (_c, s) => requireSignIn(s),
  sync: (ctx) => syncGithub(ctx, signedInDeps(ctx)),
};
