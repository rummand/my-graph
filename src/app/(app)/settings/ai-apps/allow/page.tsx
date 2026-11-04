import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { checkAuthorize, dbStore, hostOf, isLocalRedirect, originFromHeaders, paramsOf, PARAMS } from "@/lib/mcp-server";
import { mayConnectApps, pickableGraphs } from "@/lib/mcp-server/account";
import { headers } from "next/headers";
import { ConsentForm } from "../_components/consent-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("mcpServer.consent.metaTitle") };
}
export const dynamic = "force-dynamic";

const PROBLEMS = ["unknownApp", "badRedirect", "onlyRead", "inactive", "pickGraph", "cantWrite", "signedOut", "notAllowed"];

/**
 * The OAuth consent page (the authorization endpoint). Signed out, the middleware sends the person to sign in and back
 * here. It says which app asks (by the name it gave itself, not checked), where the answer goes, who is signed in, and
 * lets them pick ONE graph and read or read + propose. An unknown app or an unregistered redirect is said here and
 * never redirected to; any other problem goes back to the app as error=… (OAuth 2.1).
 */
export default async function AllowAppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const t = await getT();
  const sp = await searchParams;
  const p = paramsOf(sp);
  const origin = originFromHeaders(await headers());
  const checked = await checkAuthorize(dbStore, origin, p);
  if (!checked.ok && "redirect" in checked) redirect(checked.redirect);
  const shown = typeof sp.problem === "string" && PROBLEMS.includes(sp.problem) ? sp.problem : null;

  if (!checked.ok) {
    return (
      <div className="max-w-xl py-4">
        <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("mcpServer.consent.metaTitle")}</h1>
        <p role="alert" className="mt-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{t(`mcpServer.consent.problem.${"show" in checked ? checked.show : "unknownApp"}`)}</p>
      </div>
    );
  }
  const { req } = checked;
  const graphs = mayConnectApps(v) ? await pickableGraphs(v) : [];
  const hidden = Object.fromEntries(PARAMS.filter((k) => p[k]).map((k) => [k, p[k]!]));
  return (
    <ConsentForm
      app={req.client.name} host={hostOf(req.redirectUri)} local={isLocalRedirect(req.redirectUri)}
      person={{ name: v.name, email: v.email }} graphs={graphs} defaultGraphId={v.graphId}
      offered={req.offered} hidden={hidden} problem={!mayConnectApps(v) ? "notAllowed" : shown}
    />
  );
}
