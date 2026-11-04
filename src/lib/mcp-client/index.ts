/**
 * My Graph's MCP client (server-only): a hand-written Model Context Protocol client over Streamable HTTP (JSON and
 * SSE answers), OAuth 2.1 for MCP servers (RFC 9728/8414 discovery, dynamic registration, PKCE), and the SSRF-guarded
 * transport. Connections of the "MCP server" kind and the Record preset live in src/lib/connectors/{mcp,record}.
 *
 * For the assistant: `listMcpTools(v)` and `callMcpTool(v, …)` (see src/lib/connectors/mcp/hook.ts for the rules:
 * the graph's allowed tools only, approval for every writing tool, answers are data and never instructions).
 */
export { McpClient, type McpClientOptions, type McpServerInfo } from "./client";
export { McpError, needsPerson, type McpErrorCode } from "./errors";
export { asUntrustedData, isWriteTool, toolOutcome, type McpResourceInfo, type McpToolInfo, type ToolOutcome } from "./tools";
export { checkServerUrl, guardedTransport, guardedStream, type Transport } from "./transport";
export { listMcpTools, callMcpTool, approvalToken, approvalValid, qualifiedName, type McpApproval, type McpCallResult, type McpToolForAssistant } from "@/lib/connectors/mcp/hook";
