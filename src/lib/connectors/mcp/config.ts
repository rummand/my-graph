/**
 * What an MCP connection keeps (pure). Config (not secret): the server's address, how it signs in, who may see what it
 * brings in, which tools the assistant may use in this graph, and the server's catalog (tools and resources) as it
 * was last read. Secrets (encrypted): an API key, or the OAuth sign-in as one JSON string (client registration,
 * tokens, and, while a sign-in is under way, its PKCE verifier and state).
 */
import { z } from "zod";

export const mcpToolSchema = z.object({
  name: z.string().max(128),
  title: z.string().max(120).nullish(),
  description: z.string().max(1000).nullish(),
  writes: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()).nullish(),
});

export const mcpResourceSchema = z.object({ uri: z.string().max(2000), name: z.string().max(200), description: z.string().max(500).nullish() });

const visibility = z.enum(["private", "parents", "household"]).default("private");

export const mcpConfig = z.object({
  serverUrl: z.string().trim().min(8, "Paste the server's address.").max(2000),
  authMode: z.enum(["key", "oauth", "none"]).default("key"),
  visibility,
  /** Tools the assistant may use in this graph. Writing tools are never on by default. */
  allowedTools: z.array(z.string().max(128)).max(300).default([]),
  /** A person chose the tools (until then, the read-only ones are on). */
  toolsChosen: z.boolean().optional(),
  /** Filled in by the connection itself. */
  feedHost: z.string().max(253).optional(),
  serverName: z.string().max(200).nullish(),
  tools: z.array(mcpToolSchema).max(300).optional(),
  resources: z.array(mcpResourceSchema).max(300).optional(),
  catalogAt: z.string().max(40).optional(),
  /** Record: only meetings on or after this day the first time. */
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Connected from the Apps directory: the entry's id (see ./directory). Only a label; it grants nothing. */
  directoryId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});
export type McpConfig = z.infer<typeof mcpConfig>;

export const mcpSecrets = z.object({
  apiKey: z.string().max(2000).optional(),
  /** OAuthState as JSON. */
  oauth: z.string().max(20_000).optional(),
});

export type OAuthState = {
  issuer: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  revocationEndpoint?: string | null;
  resource: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
  /** While a sign-in is under way. */
  pending?: { state: string; verifier: string; expiresAt: number } | null;
};

export function readOAuth(secrets: Record<string, string>): OAuthState | null {
  if (!secrets.oauth) return null;
  try {
    const o = JSON.parse(secrets.oauth) as OAuthState;
    return o && typeof o === "object" && typeof o.clientId === "string" ? o : null;
  } catch {
    return null;
  }
}

/** The tools that are on: what a person chose, or (before they chose) every tool that only reads. */
export function enabledTools(cfg: Pick<McpConfig, "allowedTools" | "toolsChosen" | "tools">): string[] {
  if (cfg.toolsChosen) return cfg.allowedTools;
  return (cfg.tools ?? []).filter((t) => !t.writes).map((t) => t.name);
}
