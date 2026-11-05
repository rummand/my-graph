import { route } from "@/lib/connectors/http";
import { appOrigin, CALLBACK_PATH } from "@/lib/connectors/oauth/flow";
import { pickerSettings, providerInfo, type ProviderId } from "@/lib/connectors/oauth/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → which providers this My Graph is set up for (never the secrets themselves, only which settings are missing),
 * and the exact redirect address to register in each provider's console.
 */
export const GET = route(async (req) => {
  const ids: ProviderId[] = ["google", "microsoft", "dropbox", "github", "linear", "slack", "notion"];
  const providers = Object.fromEntries(ids.map((id) => {
    const p = providerInfo(id);
    return [id, { configured: p.missing.length === 0, missing: p.missing, settings: p.envNames }];
  }));
  return { providers, redirectUri: `${appOrigin(req)}${CALLBACK_PATH}`, origin: appOrigin(req), picker: !!pickerSettings() };
});
