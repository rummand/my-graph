"use client";
/**
 * What the assistant (the Ask window) may do on the Connections pages, as page actions (see
 * src/components/assistant/page-actions.ts): look at what can be connected and what is, and open a connector's setup.
 * Nothing here connects anything: the person fills in and sends the setup form themselves.
 */
import { useRouter } from "next/navigation";
import { z } from "zod";
import { usePageActions, type PageAction } from "@/components/assistant/page-actions";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";

/** Aula signs in through its helper page, the Mac pairs its helper: their setup is a page of its own. */
const OWN_PAGE = new Set(["aula", "mac"]);

export function setupHref(connectorId: string): string {
  return OWN_PAGE.has(connectorId) ? `/connections/${connectorId}` : `/connections?setup=${encodeURIComponent(connectorId)}`;
}

/**
 * `connectors`: what this graph offers (empty on a connection's own page: then setup opens on /connections).
 * `openSetup`: open a gallery item in place (the gallery page); otherwise it navigates.
 */
export function useConnectionsActions({ connectors, connections, openSetup }: {
  connectors: ConnectorInfo[]; connections: ConnectionDTO[]; openSetup?: (connectorId: string) => void;
}) {
  const t = useT();
  const router = useRouter();
  const name = (id: string) => t(`connections.connectors.${id}.title`, undefined, id);
  usePageActions([
    {
      id: "connections.list",
      title: t("connections.assistantActions.list"),
      description: "What can be connected in this graph (connector ids and names, whether available yet) and the person's own connections here (id, connector, name, status).",
      input: z.object({}),
      danger: "read",
      run: () => ({
        summary: t("connections.assistantActions.listed", { count: connections.length }),
        data: {
          offered: connectors.map((c) => ({ id: c.id, name: name(c.id), available: c.status !== "coming_soon", region: c.region ?? null })),
          yours: connections.map((c) => ({ id: c.id, connector: c.connector, name: c.label, status: c.status })),
        },
      }),
    } satisfies PageAction<Record<string, unknown>>,
    {
      id: "connections.open_setup",
      title: t("connections.assistantActions.openSetup"),
      description: "Open the setup of a connector (by connector id from connections.list, e.g. ics, imap, gmail, aula) so the person can fill it in. Or open one of their connections (connectionId) to see its status and settings. Doesn't connect anything by itself.",
      input: z.object({ connectorId: z.string().trim().min(1).max(60).optional(), connectionId: z.uuid().optional() })
        .refine((i) => !!i.connectorId || !!i.connectionId, "Give a connectorId or a connectionId."),
      danger: "read",
      run: (i: { connectorId?: string; connectionId?: string }) => {
        if (i.connectionId) {
          router.push(`/connections/${i.connectionId}`);
          return t("connections.assistantActions.opened", { name: connections.find((c) => c.id === i.connectionId)?.label ?? "" });
        }
        const id = i.connectorId!;
        const info = connectors.find((c) => c.id === id);
        if (connectors.length && !info) throw new Error(`There is no connector "${id}" in this graph.`);
        if (info?.status === "coming_soon") throw new Error(`${name(id)} isn't available yet.`);
        if (openSetup && !OWN_PAGE.has(id)) openSetup(id);
        else router.push(setupHref(id));
        return t("connections.assistantActions.opened", { name: name(id) });
      },
    } satisfies PageAction<{ connectorId?: string; connectionId?: string }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as PageAction<any>[], [t, router, connectors, connections, openSetup]);
}

/** For server-rendered connection pages: registers the actions, renders nothing. */
export function ConnectionsPageActions(p: { connectors: ConnectorInfo[]; connections: ConnectionDTO[] }) {
  useConnectionsActions(p);
  return null;
}
