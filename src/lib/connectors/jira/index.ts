/** Jira Cloud connector (server-only): site address, email and API token, read-only. */
import type { Connector } from "../types";
import { keyDeps } from "../github/deps";
import { checkJira, jiraAuthorization, jiraManifest, syncJira, type JiraConfig } from "./connector";

export const jiraConnector: Connector<JiraConfig> = {
  manifest: jiraManifest,
  check: (_c, s) => checkJira(s),
  describe: (c) => ({ feedHost: new URL(c.jiraSite).host }),
  sync: (ctx) => syncJira(ctx, keyDeps(ctx, jiraAuthorization(ctx.config.jiraEmail, ctx.secrets.jiraToken ?? ""), "Jira")),
};
