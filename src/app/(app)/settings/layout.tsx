import { isParent, requireUser } from "@/lib/auth";
import { SettingsNav, type SettingsTab } from "./_components/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const v = await requireUser();
  const tabs: SettingsTab[] = [
    { href: "/settings", label: "Profile", icon: "profile" },
    { href: "/settings/security", label: "Sign-in & devices", icon: "security" },
    ...(isParent(v) ? [
      { href: "/settings/family", label: "Family", icon: "family" } as const,
      { href: "/settings/audit", label: "Activity log", icon: "audit" } as const,
    ] : []),
    ...(v.role !== "guest" ? [{ href: "/people/model", label: "Kinds & relations", icon: "model", external: true } as const] : []),
  ];
  return (
    <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
      <SettingsNav tabs={tabs} />
      <div className="min-w-0 max-w-[920px]">{children}</div>
    </div>
  );
}
