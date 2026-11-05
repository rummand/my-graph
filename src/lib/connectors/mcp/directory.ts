/**
 * Apps: a curated directory of vendors' own remote MCP servers (pure). Each entry is only a preset for the ordinary MCP
 * connection (address, how it signs in, a label): connecting one gives no new trust. Tools that read are on to begin
 * with, tools that change something stay off and ask each time, unattended runs get reading tools only.
 *
 * Every address was checked against the vendor's own documentation (or the official MCP registry entry in the
 * vendor's namespace) on 2026-11-05; `docsUrl` is the page it was checked against. Servers that only accept clients
 * the vendor approved in advance (no dynamic client registration and no API key) are left out, because My Graph
 * registers itself.
 */
import type { GraphKind } from "@/lib/graphs/pure";

export const APP_CATEGORIES = ["design", "projects", "money", "files", "sales", "meetings", "automation", "life", "dev", "knowledge"] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/**
 * What a person should know before connecting. paid: needs a paid plan. admin: an admin must turn it on first.
 * beta: the vendor calls it beta or preview. approval: the vendor may have to approve My Graph as an app.
 * readsOnly: the server only reads. ownServer: the address is your own (per account or instance). usage: tool calls
 * count against the plan's allowance or credits. moneyMoves: some tools can move money or run payroll.
 */
export const APP_NOTES = ["paid", "admin", "beta", "approval", "readsOnly", "ownServer", "usage", "moneyMoves"] as const;
export type AppNote = (typeof APP_NOTES)[number];

export type AppAuth = "oauth" | "key" | "none";

export type DirectoryApp = {
  id: string;
  name: string;
  vendor: string;
  category: AppCategory;
  /** The vendor's server. With the `ownServer` note it holds `{instance}`, the person's own host. */
  serverUrl: string;
  /** How it signs in by default. */
  auth: AppAuth;
  /** An API key also works (sent as a bearer token), with `apps.entries.<id>.key` saying where to make one. */
  alsoKey?: boolean;
  /** The vendor's read-only address: used unless the person lets it change things too. */
  readOnlyUrl?: string;
  /** The vendor's address for accounts kept in the EU. */
  euUrl?: string;
  /** Where the address and sign-in were verified. */
  docsUrl: string;
  /** Only offered in these graph kinds (all when absent). */
  graphKinds?: GraphKind[];
  region?: "dk";
  notes: AppNote[];
};

/** Plain-words description, `apps.entries.<id>.does`. */
export const descriptionKey = (id: string) => `apps.entries.${id}.does`;
export const keyHintKey = (id: string) => `apps.entries.${id}.key`;

const WORKISH: GraphKind[] = ["personal", "work", "shared", "other", "partner", "project"];

export const DIRECTORY: DirectoryApp[] = [
  // Whiteboards, design and websites
  { id: "miro", name: "Miro", vendor: "Miro", category: "design", serverUrl: "https://mcp.miro.com/", auth: "oauth", docsUrl: "https://developers.miro.com/docs/mcp-intro", notes: ["admin", "usage"] },
  { id: "canva", name: "Canva", vendor: "Canva", category: "design", serverUrl: "https://mcp.canva.com/mcp", auth: "oauth", docsUrl: "https://www.canva.dev/docs/mcp/verify-integration/", notes: [] },
  { id: "lucid", name: "Lucid", vendor: "Lucid Software", category: "design", serverUrl: "https://mcp.lucid.app/mcp", readOnlyUrl: "https://mcp.lucid.app/mcp/readonly", auth: "oauth", docsUrl: "https://help.lucid.co/hc/en-us/articles/42578801807508", notes: ["admin"] },
  { id: "excalidraw", name: "Excalidraw", vendor: "Excalidraw", category: "design", serverUrl: "https://mcp.excalidraw.com", auth: "none", docsUrl: "https://github.com/excalidraw/excalidraw-mcp", notes: [] },
  { id: "webflow", name: "Webflow", vendor: "Webflow", category: "design", serverUrl: "https://mcp.webflow.com/mcp", auth: "oauth", docsUrl: "https://developers.webflow.com/mcp/reference/getting-started", notes: [] },
  { id: "wix", name: "Wix", vendor: "Wix", category: "design", serverUrl: "https://mcp.wix.com/mcp", auth: "oauth", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=com.wix", notes: [] },
  { id: "cloudinary", name: "Cloudinary", vendor: "Cloudinary", category: "design", serverUrl: "https://asset-management.mcp.cloudinary.com/mcp", auth: "oauth", docsUrl: "https://github.com/cloudinary/mcp-servers", notes: [] },

  // Projects and tasks
  { id: "asana", name: "Asana", vendor: "Asana", category: "projects", serverUrl: "https://mcp.asana.com/v2/mcp", auth: "oauth", docsUrl: "https://developers.asana.com/docs/using-asanas-mcp-server", notes: ["approval"] },
  { id: "atlassian", name: "Jira and Confluence (Rovo)", vendor: "Atlassian", category: "projects", serverUrl: "https://mcp.atlassian.com/v2/mcp", auth: "oauth", docsUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/", notes: ["usage"] },
  { id: "trello", name: "Trello", vendor: "Atlassian", category: "projects", serverUrl: "https://mcp.trello.com/v1", auth: "oauth", docsUrl: "https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/", notes: [] },
  { id: "monday", name: "monday.com", vendor: "monday.com", category: "projects", serverUrl: "https://mcp.monday.com/mcp", auth: "oauth", alsoKey: true, docsUrl: "https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp", notes: ["usage"] },
  { id: "clickup", name: "ClickUp", vendor: "ClickUp", category: "projects", serverUrl: "https://mcp.clickup.com/mcp", auth: "oauth", docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server", notes: ["beta", "usage"] },
  { id: "todoist", name: "Todoist", vendor: "Doist", category: "projects", serverUrl: "https://ai.todoist.net/mcp", auth: "oauth", docsUrl: "https://github.com/Doist/todoist-ai", notes: [] },
  { id: "airtable", name: "Airtable", vendor: "Airtable", category: "projects", serverUrl: "https://mcp.airtable.com/mcp", auth: "oauth", alsoKey: true, docsUrl: "https://airtable.com/developers/agents/mcp/getting-started", notes: [] },
  { id: "smartsheet", name: "Smartsheet", vendor: "Smartsheet", category: "projects", serverUrl: "https://mcp.smartsheet.com", euUrl: "https://mcp.smartsheet.eu", auth: "key", docsUrl: "https://developers.smartsheet.com/ai-mcp/smartsheet/install-the-smartsheet-mcp-server", notes: ["paid"] },
  { id: "linear", name: "Linear", vendor: "Linear", category: "projects", serverUrl: "https://mcp.linear.app/mcp", readOnlyUrl: "https://mcp.linear.app/mcp/readonly", auth: "oauth", alsoKey: true, docsUrl: "https://linear.app/docs/mcp", notes: [] },
  { id: "notion", name: "Notion", vendor: "Notion", category: "projects", serverUrl: "https://mcp.notion.com/mcp", auth: "oauth", docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp", notes: [] },
  { id: "wrike", name: "Wrike", vendor: "Wrike", category: "projects", serverUrl: "https://mcp.wrike.com/v2", auth: "key", docsUrl: "https://developers.wrike.com/docs/wrike-mcp-server-overview", notes: [] },

  // Money
  { id: "stripe", name: "Stripe", vendor: "Stripe", category: "money", serverUrl: "https://mcp.stripe.com", auth: "oauth", alsoKey: true, docsUrl: "https://docs.stripe.com/mcp", notes: ["moneyMoves"] },
  { id: "paypal", name: "PayPal", vendor: "PayPal", category: "money", serverUrl: "https://mcp.paypal.com/http", auth: "oauth", docsUrl: "https://developer.paypal.com/tools/mcp-server/", notes: ["moneyMoves"] },
  { id: "square", name: "Square", vendor: "Block", category: "money", serverUrl: "https://mcp.squareup.com/mcp", auth: "oauth", docsUrl: "https://developer.squareup.com/docs/mcp", notes: ["approval", "moneyMoves"] },
  { id: "mercury", name: "Mercury", vendor: "Mercury", category: "money", serverUrl: "https://mcp.mercury.com/mcp", auth: "oauth", docsUrl: "https://docs.mercury.com/docs/connecting-mercury-mcp", notes: ["beta"] },
  { id: "brex", name: "Brex", vendor: "Brex", category: "money", serverUrl: "https://api.brex.com/mcp", auth: "oauth", alsoKey: true, docsUrl: "https://developer.brex.com/docs/mcp", notes: ["admin", "beta"] },
  { id: "gusto", name: "Gusto", vendor: "Gusto", category: "money", serverUrl: "https://mcp.api.gusto.com", auth: "oauth", docsUrl: "https://docs.gusto.com/app-integrations/docs/mcp", notes: ["admin", "moneyMoves"] },
  { id: "pleo", name: "Pleo", vendor: "Pleo", category: "money", region: "dk", serverUrl: "https://mcp.pleo.io/mcp", auth: "oauth", docsUrl: "https://developers.pleo.io/docs/current/pleo-mcp/how-tos/installation/custom-mcp", notes: ["admin"] },

  // Documents and files
  { id: "dropbox", name: "Dropbox", vendor: "Dropbox", category: "files", serverUrl: "https://mcp.dropbox.com/mcp", auth: "oauth", docsUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", notes: ["beta"] },
  { id: "egnyte", name: "Egnyte", vendor: "Egnyte", category: "files", serverUrl: "https://mcp-server.egnyte.com/mcp", auth: "oauth", docsUrl: "https://developers.egnyte.com/integration/cfs/api-docs/remote-mcp-server", notes: ["paid", "admin"] },

  // Sales, support and forms
  { id: "intercom", name: "Intercom", vendor: "Intercom", category: "sales", serverUrl: "https://mcp.intercom.com/mcp", euUrl: "https://mcp.eu.intercom.com/mcp", auth: "oauth", alsoKey: true, docsUrl: "https://developers.intercom.com/docs/guides/mcp", notes: ["approval"] },
  { id: "pipedrive", name: "Pipedrive", vendor: "Pipedrive", category: "sales", serverUrl: "https://mcp.pipedrive.ai/mcp", auth: "oauth", docsUrl: "https://support.pipedrive.com/en/article/mcp-claude", notes: ["beta"] },
  { id: "attio", name: "Attio", vendor: "Attio", category: "sales", serverUrl: "https://mcp.attio.com/mcp", auth: "oauth", docsUrl: "https://docs.attio.com/mcp/overview", notes: [] },
  { id: "close", name: "Close", vendor: "Close", category: "sales", serverUrl: "https://mcp.close.com/mcp", auth: "oauth", docsUrl: "https://developer.close.com/mcp/", notes: [] },
  { id: "klaviyo", name: "Klaviyo", vendor: "Klaviyo", category: "sales", serverUrl: "https://mcp.klaviyo.com/mcp", readOnlyUrl: "https://mcp.klaviyo.com/mcp?read-only=true", auth: "oauth", docsUrl: "https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server", notes: ["admin"] },
  { id: "typeform", name: "Typeform", vendor: "Typeform", category: "sales", serverUrl: "https://api.typeform.com/mcp", euUrl: "https://api.eu.typeform.com/mcp", auth: "oauth", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=com.typeform", notes: [] },
  { id: "jotform", name: "Jotform", vendor: "Jotform", category: "sales", serverUrl: "https://mcp.jotform.com/", auth: "oauth", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=com.jotform", notes: [] },

  // Meetings and calls
  { id: "fireflies", name: "Fireflies", vendor: "Fireflies.ai", category: "meetings", serverUrl: "https://api.fireflies.ai/mcp", auth: "oauth", alsoKey: true, docsUrl: "https://docs.fireflies.ai/getting-started/mcp-configuration", notes: [] },
  { id: "granola", name: "Granola", vendor: "Granola", category: "meetings", serverUrl: "https://mcp.granola.ai/mcp", auth: "oauth", docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp", notes: [] },
  { id: "zoom", name: "Zoom", vendor: "Zoom", category: "meetings", serverUrl: "https://mcp.zoom.us/mcp/meeting/streamable", auth: "oauth", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.zoom", notes: [] },
  { id: "calendly", name: "Calendly", vendor: "Calendly", category: "meetings", serverUrl: "https://mcp.calendly.com", auth: "oauth", docsUrl: "https://developer.calendly.com/calendly-mcp-server", notes: [] },
  { id: "fathom", name: "Fathom", vendor: "Fathom", category: "meetings", serverUrl: "https://api.fathom.ai/mcp", auth: "oauth", docsUrl: "https://developers.fathom.ai/mcp-docs", notes: [] },
  { id: "readai", name: "Read AI", vendor: "Read AI", category: "meetings", serverUrl: "https://api.read.ai/mcp", auth: "oauth", docsUrl: "https://support.read.ai/hc/en-us/articles/49381158409491-MCP-Server", notes: ["beta", "readsOnly"] },

  // Automation
  { id: "zapier", name: "Zapier", vendor: "Zapier", category: "automation", serverUrl: "https://mcp.zapier.com/api/v1/connect", auth: "oauth", alsoKey: true, docsUrl: "https://docs.zapier.com/mcp/overview/how-connections-work", notes: ["usage"] },
  { id: "make", name: "Make", vendor: "Make", category: "automation", serverUrl: "https://mcp.make.com/v2", auth: "oauth", docsUrl: "https://developers.make.com/mcp-server/make-mcp-server", notes: ["usage"] },
  { id: "n8n", name: "n8n", vendor: "n8n", category: "automation", serverUrl: "https://{instance}/mcp-server/http", auth: "key", docsUrl: "https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server", notes: ["ownServer", "admin"] },
  { id: "ifttt", name: "IFTTT", vendor: "IFTTT", category: "automation", serverUrl: "https://ifttt.com/mcp", auth: "oauth", docsUrl: "https://ifttt.com/mcp", notes: [] },

  // Everyday life
  { id: "strava", name: "Strava", vendor: "Strava", category: "life", serverUrl: "https://mcp.strava.com/mcp", auth: "oauth", docsUrl: "https://support.strava.com/hc/en-us/articles/15401531", notes: ["paid", "readsOnly"] },

  // Software and developer tools (not in a family graph)
  { id: "github", name: "GitHub", vendor: "GitHub", category: "dev", graphKinds: WORKISH, serverUrl: "https://api.githubcopilot.com/mcp/", auth: "key", docsUrl: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md", notes: [] },
  { id: "sentry", name: "Sentry", vendor: "Sentry", category: "dev", graphKinds: WORKISH, serverUrl: "https://mcp.sentry.dev/mcp", auth: "oauth", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.getsentry", notes: [] },
  { id: "supabase", name: "Supabase", vendor: "Supabase", category: "dev", graphKinds: WORKISH, serverUrl: "https://mcp.supabase.com/mcp", auth: "oauth", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=com.supabase", notes: [] },
  { id: "netlify", name: "Netlify", vendor: "Netlify", category: "dev", graphKinds: WORKISH, serverUrl: "https://mcp.netlify.com/mcp", auth: "oauth", docsUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/", notes: [] },
  { id: "posthog", name: "PostHog", vendor: "PostHog", category: "dev", graphKinds: WORKISH, serverUrl: "https://mcp.posthog.com/mcp", auth: "key", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.PostHog", notes: [] },
  { id: "cloudflare-docs", name: "Cloudflare docs", vendor: "Cloudflare", category: "dev", graphKinds: WORKISH, serverUrl: "https://docs.mcp.cloudflare.com/mcp", auth: "none", docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=com.cloudflare", notes: ["readsOnly"] },
  { id: "huggingface", name: "Hugging Face", vendor: "Hugging Face", category: "dev", graphKinds: WORKISH, serverUrl: "https://huggingface.co/mcp", auth: "none", alsoKey: true, docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=co.huggingface", notes: [] },
  { id: "context7", name: "Context7", vendor: "Upstash", category: "dev", graphKinds: WORKISH, serverUrl: "https://mcp.context7.com/mcp", auth: "none", alsoKey: true, docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.upstash", notes: ["readsOnly"] },

  // Search and knowledge
  { id: "exa", name: "Exa", vendor: "Exa", category: "knowledge", serverUrl: "https://mcp.exa.ai/mcp", auth: "none", alsoKey: true, docsUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=ai.exa", notes: ["readsOnly"] },
  { id: "wikidata", name: "Wikidata", vendor: "Wikimedia Deutschland", category: "knowledge", serverUrl: "https://wd-mcp.wmcloud.org/mcp/", auth: "none", docsUrl: "https://www.wikidata.org/wiki/Wikidata:MCP", notes: ["beta", "readsOnly"] },
];

export function appById(id: unknown): DirectoryApp | null {
  return typeof id === "string" ? DIRECTORY.find((a) => a.id === id) ?? null : null;
}

/** The apps offered in a graph of this kind. */
export function appsFor(graphKind: GraphKind | string | null | undefined): DirectoryApp[] {
  return DIRECTORY.filter((a) => !a.graphKinds || (graphKind != null && (a.graphKinds as string[]).includes(graphKind)));
}

export type AppFilter = { category?: AppCategory | "all" | "dk" | null; query?: string | null };

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Filter by category ("dk" = Danish services) and a search over the name, vendor and the description shown.
 * `describe` gives the translated description so a person can search in their own language.
 */
export function filterApps(apps: DirectoryApp[], f: AppFilter, describe: (a: DirectoryApp) => string = () => ""): DirectoryApp[] {
  const words = fold(f.query ?? "").split(/\s+/).filter(Boolean);
  return apps.filter((a) => {
    if (f.category === "dk") { if (a.region !== "dk") return false; }
    else if (f.category && f.category !== "all" && a.category !== f.category) return false;
    if (!words.length) return true;
    const hay = fold(`${a.name} ${a.vendor} ${a.id} ${describe(a)}`);
    return words.every((w) => hay.includes(w));
  });
}

/** The categories that have at least one app, in directory order. */
export function categoriesOf(apps: DirectoryApp[]): AppCategory[] {
  return APP_CATEGORIES.filter((c) => apps.some((a) => a.category === c));
}

/** The address to connect to: read-only unless the person lets it change things, the EU one if asked. */
export function serverUrlFor(app: DirectoryApp, opts: { allowWrites?: boolean; eu?: boolean } = {}): string {
  if (app.notes.includes("ownServer")) return "";
  if (!opts.allowWrites && app.readOnlyUrl) return app.readOnlyUrl;
  if (opts.eu && app.euUrl) return app.euUrl;
  return app.serverUrl;
}

/** Is this connection (its config) the given app? */
export function isConnectionOf(config: Record<string, unknown> | null | undefined, app: DirectoryApp): boolean {
  return !!config && config.directoryId === app.id;
}
