import type { Metadata } from "next";
import { headers } from "next/headers";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { connectedApps, dbStore, listKeys, originFromHeaders } from "@/lib/mcp-server";
import { mayConnectApps, pickableGraphs } from "@/lib/mcp-server/account";
import { askPerDay } from "@/lib/mcp-server/rate";
import { isPlatformAdmin } from "@/lib/plans";
import { installedPlugins, pluginsDir } from "@/lib/plugins/manifest";
import { Row } from "../_components/section";
import { AppsPanel } from "./_components/apps-panel";
import { KeysPanel } from "./_components/keys-panel";
import { SetupPanel } from "./_components/setup-panel";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("mcpServer.metaTitle") };
}
export const dynamic = "force-dynamic";

/**
 * AI apps and MCP: My Graph as an MCP server for Claude, ChatGPT and Claude Code. The apps a person connected (each in
 * one graph, read or read + propose), their personal access keys, and how to add My Graph to each assistant.
 */
export default async function AiAppsPage() {
  const v = await requireUser();
  const t = await getT();
  if (!mayConnectApps(v)) return <EmptyState title={t("mcpServer.notAllowed")} />;
  const origin = originFromHeaders(await headers());
  const [apps, keys, graphs] = await Promise.all([connectedApps(dbStore, v.id), listKeys(dbStore, v.id), pickableGraphs(v)]);
  const graphName = Object.fromEntries(graphs.map((g) => [g.id, g.name]));
  const limit = askPerDay();
  const ITEMS = ["search", "node", "people", "timeline", "history", "document", "ask", "propose"] as const;

  return (
    <>
      <PageHeader title={t("mcpServer.title")} lead={t("mcpServer.lead")} />
      <Row id="apps-h" title={t("mcpServer.apps.title")} lead={t("mcpServer.apps.lead")} flush>
        <AppsPanel initial={apps} graphName={graphName} />
      </Row>
      <Row id="setup-h" title={t("mcpServer.setup.title")} lead={t("mcpServer.setup.lead")}>
        <SetupPanel address={`${origin}/api/mcp`} />
      </Row>
      <Row id="keys-h" title={t("mcpServer.keys.title")} lead={t("mcpServer.keys.lead")}>
        <KeysPanel initial={keys} graphs={graphs} defaultGraphId={v.graphId} address={`${origin}/api/mcp`} />
      </Row>
      <Row id="tools-h" title={t("mcpServer.tools.title")} lead={t("mcpServer.tools.safety")}>
        <ul className="space-y-1.5 text-sm">
          {ITEMS.map((k) => (
            <li key={k} className="flex gap-2">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              <span>{t(`mcpServer.tools.items.${k}`, { limit })}</span>
            </li>
          ))}
        </ul>
      </Row>
      {isPlatformAdmin(v) && <PluginsRow t={t} />}
    </>
  );
}

/** For the platform admin: the connector plugins installed on this server (never uploaded; see docs/plugins). */
function PluginsRow({ t }: { t: (k: string, vars?: Record<string, string | number>) => string }) {
  const dir = pluginsDir();
  const { plugins, problems } = installedPlugins();
  return (
    <Row id="plugins-h" title={t("mcpServer.plugins.title")} lead={t("mcpServer.plugins.lead")}>
      <p className="text-sm text-muted">{dir ? t("mcpServer.plugins.dir", { dir }) : t("mcpServer.plugins.noDir")}</p>
      {plugins.length ? (
        <ul className="mt-3 divide-y divide-line">
          {plugins.map((p) => (
            <li key={p.id} className="py-2.5">
              <p className="flex flex-wrap items-baseline gap-x-2"><span className="font-medium">{p.name}</span><code className="font-mono text-xs text-muted">{p.id} {p.version}</code></p>
              {p.description && <p className="mt-0.5 text-sm text-muted">{p.description}</p>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm">{t("mcpServer.plugins.none")}</p>}
      {problems.length > 0 && (
        <div className="mt-3 text-sm text-warn">
          <p>{t("mcpServer.plugins.problems")}</p>
          <ul className="mt-1 list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      <p className="mt-4 text-sm text-muted">{t("mcpServer.plugins.howTo")}</p>
    </Row>
  );
}
