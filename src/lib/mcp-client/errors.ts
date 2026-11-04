/**
 * MCP client errors, with a code the Connections page can say in plain words. `auth` means the server wants a
 * (fresh) sign-in; its `wwwAuthenticate` header says where (RFC 9728 resource_metadata).
 */
export type McpErrorCode =
  | "badUrl" | "privateHost" | "timeout" | "network" | "dns" | "tooLarge" | "aborted"
  | "auth" | "forbidden" | "rateLimited" | "serverError" | "http" | "protocol" | "rpc" | "toolMissing" | "oauth";

export class McpError extends Error {
  constructor(message: string, readonly code: McpErrorCode, readonly extra: { status?: number; rpcCode?: number; wwwAuthenticate?: string | null; retryAfter?: string | null } = {}) {
    super(message);
    this.name = "McpError";
  }
}

/** Errors a person has to act on (sign in again, fix the address); the rest are worth retrying later. */
export function needsPerson(e: unknown): boolean {
  return e instanceof McpError && ["badUrl", "privateHost", "auth", "forbidden", "oauth"].includes(e.code);
}
