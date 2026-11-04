import { isParent, requireUser } from "@/lib/auth";
import { canUseAssistantTools } from "@/lib/automations/policy";
import { SettingsNav, type SettingsTab } from "./_components/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const v = await requireUser();
  const parent = isParent(v);
  const tabs: SettingsTab[] = [
    { href: "/settings#profile", key: "profile", anchor: true },
    { href: "/settings#language", key: "language", anchor: true },
    { href: "/settings#appearance", key: "appearance", anchor: true },
    { href: "/settings#security", key: "security", anchor: true },
    { href: "/settings#graph", key: "graph", anchor: true },
    ...(parent ? [{ href: "/settings#household", key: "household", anchor: true } as const] : []),
    ...(canUseAssistantTools(v) ? [{ href: "/settings#assistant", key: "assistant", anchor: true } as const] : []),
    ...(v.role !== "guest" && v.role !== "child" ? [{ href: "/settings#connections", key: "connections", anchor: true } as const] : []),
    { href: "/settings#data", key: "data", anchor: true },
    ...(parent ? [
      { href: "/settings/family", key: "family" } as const,
      { href: "/settings/audit", key: "audit" } as const,
    ] : []),
    ...(v.role !== "guest" ? [{ href: "/people/model", key: "model", external: true } as const] : []),
  ];
  return (
    <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
      <SettingsNav tabs={tabs} />
      <div className="min-w-0 max-w-[920px]">{children}</div>
    </div>
  );
}
