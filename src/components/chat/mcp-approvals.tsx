"use client";
/**
 * Actions at connected services (MCP) an answer prepared but that change something: one approval card each. After
 * "Approve and run" the tool runs as the person, and what the service answered is shown under the card (as data:
 * plain text, never rendered as markup). A card whose approval ran out says so instead.
 */
import { useEffect, useState } from "react";
import { McpApprovalCard, type ApprovalOutcome } from "@/components/connections/mcp-approval-card";
import { useT } from "@/lib/i18n/client";
import { approvalExpired, displayToolText } from "@/lib/assistant/mcp-plan";
import type { McpApproval } from "@/lib/mcp-client";

export function McpApprovals({ approvals }: { approvals: McpApproval[] }) {
  const t = useT();
  if (!approvals.length) return null;
  return (
    <section className="mt-6 space-y-2" aria-label={t("chat.message.toolsWaiting", { count: approvals.length })}>
      {approvals.map((a) => <One key={a.token.slice(-24)} approval={a} />)}
    </section>
  );
}

/**
 * Cards already answered in this browser (the token is the key), so a reload doesn't offer to run the same action
 * twice. Per-viewer convenience only: the server still checks each approval.
 */
const KEY = "mg.mcp.answered";
function answered(): Record<string, { at: number; text?: string; denied?: boolean }> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, { at: number; text?: string; denied?: boolean }>; } catch { return {}; }
}
function remember(token: string, v: { text?: string; denied?: boolean }) {
  try {
    const all = answered();
    all[token.slice(-43)] = { at: Date.now(), ...v };
    // Keep a day of answers.
    for (const [k, x] of Object.entries(all)) if (Date.now() - x.at > 86_400_000) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage blocked: the card simply shows again */ }
}

function One({ approval }: { approval: McpApproval }) {
  const t = useT();
  const [result, setResult] = useState<ApprovalOutcome | null>(null);
  const [past, setPast] = useState<{ text?: string; denied?: boolean } | null>(null);
  const [expired] = useState(() => approvalExpired(approval.expiresAt));
  const service = approval.server ?? approval.connection;
  useEffect(() => { setPast(answered()[approval.token.slice(-43)] ?? null); }, [approval.token]);
  if (past && !result) {
    return (
      <div className="rounded-lg bg-surface px-4 py-3 text-sm">
        <p className="text-muted">{t(past.denied ? "mcp.approval.denied" : "mcp.approval.done")} {approval.title ?? approval.tool}, {service}</p>
        {past.text && <p className="mt-1 whitespace-pre-wrap break-words">{past.text}</p>}
      </div>
    );
  }
  if (expired && !result) {
    return <p className="rounded-lg bg-surface px-4 py-3 text-sm text-muted">{t("chat.message.toolExpired", { tool: approval.title ?? approval.tool, service })}</p>;
  }
  const text = result?.text ? displayToolText(result.text) : "";
  return (
    <div>
      <McpApprovalCard approval={approval} onDone={(r) => {
        setResult(r);
        remember(approval.token, r ? { text: r.text ? displayToolText(r.text, 600) : undefined } : { denied: true });
      }} />
      {text && (
        <div className="mt-2 rounded-lg bg-surface px-4 py-3" role="status">
          <p className="text-xs font-medium text-muted">{t("chat.message.toolResult", { service })}</p>
          <p className={`mt-1 whitespace-pre-wrap break-words text-sm ${result?.isError ? "text-danger" : ""}`}>{text}</p>
        </div>
      )}
    </div>
  );
}
