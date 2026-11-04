"use client";
/**
 * The approval card for a tool that changes something at an MCP server (for the chat to show when callMcpTool answers
 * { status: "needs_approval", approval }). "Approve and run" sends the signed approval back as the person themself;
 * the server checks it is theirs, for this exact tool and these exact arguments, and not expired.
 */
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { formatAgo, useLocale, useT } from "@/lib/i18n/client";
import type { McpApproval } from "@/lib/connectors/mcp/hook";

export type ApprovalOutcome = { status: string; isError?: boolean; text?: string; message?: string };

export function McpApprovalCard({ approval, onDone }: { approval: McpApproval; onDone?: (r: ApprovalOutcome | null) => void }) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<"ask" | "busy" | "done" | "denied">("ask");
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setState("busy"); setError(null);
    try {
      const res = await fetch(`/api/connections/${approval.connectionId}/tools/call`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: approval.tool, args: approval.args, approval: approval.token }),
      });
      const body = (await res.json().catch(() => ({}))) as ApprovalOutcome & { error?: string };
      if (!res.ok || body.status !== "ok") throw new Error(body.error ?? body.message ?? t("connections.errors.generic"));
      setState("done");
      onDone?.(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connections.errors.generic"));
      setState("ask");
    }
  };

  return (
    <div className="rounded-lg bg-warn-tint px-4 py-3" role="group" aria-label={t("mcp.approval.title")}>
      <p className="flex items-center gap-2 font-medium text-warn"><ShieldAlert aria-hidden className="size-4" />{t("mcp.approval.title")}</p>
      <p className="mt-1 text-sm">{t("mcp.approval.body", { connection: approval.connection, tool: approval.title ?? approval.tool, server: approval.server ?? approval.connection })}</p>
      {Object.keys(approval.args).length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          {Object.entries(approval.args).map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words">{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>
          ))}
        </dl>
      )}
      {state === "done" ? <p role="status" className="mt-2 text-sm">{t("mcp.approval.done")}</p>
        : state === "denied" ? <p role="status" className="mt-2 text-sm text-muted">{t("mcp.approval.denied")}</p>
        : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void approve()} disabled={state === "busy"}>{t("mcp.approval.approve")}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setState("denied"); onDone?.(null); }} disabled={state === "busy"}>{t("mcp.approval.deny")}</Button>
            <span className="text-xs text-muted">{t("mcp.approval.expires", { when: formatAgo(approval.expiresAt, locale) })}</span>
          </div>
        )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
