import { isParent, requireUser } from "@/lib/auth";
import { canUseAssistantTools } from "@/lib/automations/policy";
import { isPlatformAdmin } from "@/lib/plans";
import { getAdminT } from "@/lib/plans/i18n";
import { getT } from "@/lib/i18n";
import { SettingsNav, type SettingsTab } from "./_components/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const v = await requireUser();
  const parent = isParent(v);
  const tabs: SettingsTab[] = [
    { href: "/settings#profile", key: "profile", anchor: true },
    { href: "/settings#language", key: "language", anchor: true },
    { href: "/settings#appearance", key: "appearance", anchor: true },
    { href: "/settings#plan", key: "plan", anchor: true },
    { href: "/settings#security", key: "security", anchor: true },
    { href: "/settings#graph", key: "graph", anchor: true },
    ...(parent ? [{ href: "/settings#household", key: "household", anchor: true } as const] : []),
    ...(canUseAssistantTools(v) ? [{ href: "/settings#assistant", key: "assistant", anchor: true } as const] : []),
    ...(v.role !== "guest" && v.role !== "child" ? [{ href: "/settings#connections", key: "connections", anchor: true } as const] : []),
    { href: "/settings#data", key: "data", anchor: true },
    // My Graph in Claude, ChatGPT and Claude Code (the MCP server): for the grown-ups, as Connections is.
    ...(v.role !== "guest" && v.role !== "child" ? [{ href: "/settings/ai-apps", key: "aiApps", label: (await getT())("mcpServer.nav") } as const] : []),
    ...(parent ? [
      { href: "/settings/family", key: "family" } as const,
      { href: "/settings/audit", key: "audit" } as const,
    ] : []),
    ...(v.role !== "guest" ? [{ href: "/people/model", key: "model", external: true } as const] : []),
    // Only the platform admin gets a way into the console (its name is translated here, never sent to others).
    ...(isPlatformAdmin(v) ? [{ href: "/admin", key: "admin", external: true, label: (await getAdminT())("admin.nav.open") } as const] : []),
  ];
  return (
    <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
      <SettingsNav tabs={tabs} />
      <div className="min-w-0 max-w-[920px]">{children}</div>
    </div>
  );
}
