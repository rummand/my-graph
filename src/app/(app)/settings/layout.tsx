import { isParent, requireUser } from "@/lib/auth";
import { SettingsNav } from "./_components/settings-nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const v = await requireUser();
  const tabs = [
    { href: "/settings", label: "Profile" },
    { href: "/settings/security", label: "Sign-in & devices" },
    ...(isParent(v) ? [{ href: "/settings/family", label: "Family" }, { href: "/settings/audit", label: "Activity log" }] : []),
    ...(v.role !== "guest" ? [{ href: "/people/model", label: "Kinds & relations" }] : []),
  ];
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Family &amp; settings</h1>
      <SettingsNav tabs={tabs} />
      <div className="mt-6">{children}</div>
    </div>
  );
}
