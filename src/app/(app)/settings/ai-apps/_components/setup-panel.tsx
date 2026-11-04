"use client";
import { useT } from "@/lib/i18n/client";
import { CopyValue } from "./copy";

/** How to add My Graph to each assistant, as Record's API and AI tools page says it. */
export function SetupPanel({ address }: { address: string }) {
  const t = useT();
  const block = (title: string, steps: string, extra?: React.ReactNode) => (
    <div className="border-t border-line pt-4">
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 text-sm text-muted">{steps}</p>
      {extra}
    </div>
  );
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-sm font-medium">{t("mcpServer.setup.address")}</p>
        <CopyValue value={address} label={t("mcpServer.setup.address")} />
      </div>
      {block(t("mcpServer.setup.claudeTitle"), t("mcpServer.setup.claudeSteps"))}
      {block(t("mcpServer.setup.chatgptTitle"), t("mcpServer.setup.chatgptSteps"))}
      {block(t("mcpServer.setup.codeTitle"), t("mcpServer.setup.codeSteps"), (
        <>
          <CopyValue className="mt-2" value={`claude mcp add --transport http my-graph ${address}`} />
          <p className="mt-3 text-sm text-muted">{t("mcpServer.setup.codeKey")}</p>
          <CopyValue className="mt-2" value={`claude mcp add --transport http my-graph ${address} --header "Authorization: Bearer mgk_…"`} />
        </>
      ))}
      {block(t("mcpServer.setup.otherTitle"), t("mcpServer.setup.otherSteps"), <CopyValue className="mt-2" value={`npx -y mcp-remote ${address}`} />)}
    </div>
  );
}
