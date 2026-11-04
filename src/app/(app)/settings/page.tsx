import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { Badge, Button, PageHeader, buttonClass } from "@/components/ui";
import { getSession, isParent, requireUser } from "@/lib/auth";
import { familyMembers, myAccount, myPasskeys, mySessions } from "@/lib/auth/settings-data";
import { canUseAssistantTools } from "@/lib/automations/policy";
import { loadGraphViews } from "@/components/graphs/data";
import { GraphSettings } from "@/components/settings/graph-settings";
import { LanguageChoice, ThemeChoice, TimeZoneChoice } from "@/components/settings/preferences";
import { getFormatDate, getPrefs, getT } from "@/lib/i18n";
import { PasskeyList } from "./_components/passkey-list";
import { PlanSection } from "./_components/plan-section";
import { PasswordForm, ProfileForm } from "./_components/profile-forms";
import { Row } from "./_components/section";
import { SessionList } from "./_components/session-list";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("settings.title") };
}
export const dynamic = "force-dynamic";

/** Group of rows the settings nav links to. */
function Group({ id, first, children }: { id: string; first?: boolean; children: React.ReactNode }) {
  // Rows drop their top padding when they come first; only the page's very first row should.
  return <div id={id} className={first ? "scroll-mt-20 lg:scroll-mt-9" : "scroll-mt-20 lg:scroll-mt-9 [&>section:first-of-type]:pt-8"}>{children}</div>;
}

/** A link to somewhere settings continue, on the panel. */
function Onward({ href, title, hint }: { href: string; title: string; hint?: string }) {
  return (
    <Link href={href} className="group flex items-center gap-3 rounded-md px-3 py-2.5 -mx-3 transition-colors hover:bg-surface-2">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {hint && <span className="block text-sm text-muted">{hint}</span>}
      </span>
      <ArrowRight size={16} className="shrink-0 text-muted transition-colors group-hover:text-fg" aria-hidden />
    </Link>
  );
}

export default async function SettingsPage() {
  const v = await requireUser();
  const s = await getSession();
  const parent = isParent(v);
  const [acct, pks, sessions, prefs, t, fmt, graphs, members] = await Promise.all([
    myAccount(v), myPasskeys(v), mySessions(v, s.status === "active" ? s.sessionId : null), getPrefs(), getT(), getFormatDate(),
    loadGraphViews(v).catch(() => []), parent ? familyMembers(v) : Promise.resolve([]),
  ]);

  // Your colour comes from your own person node in your household (the same one everywhere), not this graph's.
  const [me] = await db.select({ personNodeId: users.personNodeId }).from(users).where(eq(users.id, v.id));
  const homePerson = me?.personNodeId ?? null;
  const home = acct.householdName || t("settings.lead.yourHousehold");
  const role = t(`common.roles.${v.role}`).toLowerCase();
  // Danish short dates end in a full stop ("4. nov."); the sentence brings its own.
  const since = acct.createdAt ? fmt(acct.createdAt, "date").replace(/\.$/, "") : null;
  const lead = v.role === "owner"
    ? t(since ? "settings.lead.owner" : "settings.lead.ownerNoDate", { home, date: since ?? "" })
    : t(since ? "settings.lead.member" : "settings.lead.memberNoDate", { home, role, date: since ?? "" });

  const current = graphs.find((g) => g.isCurrent);
  const owner = current ? current.members.find((m) => m.userId === current.ownerId) : undefined;
  const pending = members.reduce((n, m) => n + m.sessions.filter((x) => !x.approved).length, 0);
  const devices = t("settings.sessions.deviceCount", { count: sessions.length });

  return (
    <>
      <PageHeader title={t("settings.title")} lead={lead} />

      <Group id="profile" first>
        <ProfileForm name={v.name} email={v.email} personId={homePerson ?? v.id} />
      </Group>

      <Group id="language">
        <Row id="language-h" title={t("settings.language.title")} lead={t("settings.language.lead")}>
          <LanguageChoice />
        </Row>
        <Row id="timezone-h" title={t("settings.timeZone.title")} lead={t("settings.timeZone.lead")}>
          <TimeZoneChoice initial={prefs.timeZone} />
        </Row>
      </Group>

      <Group id="appearance">
        <Row id="appearance-h" title={t("settings.appearance.title")} lead={t("settings.appearance.lead")}>
          <ThemeChoice initial={prefs.theme} />
        </Row>
      </Group>

      <Group id="plan">
        <PlanSection v={v} />
      </Group>

      <Group id="security">
        {s.status === "active" && s.mustChangePassword && (
          <div role="alert" className="mt-8 rounded-lg bg-warn-tint px-5 py-4">
            <p className="font-semibold text-warn">{t("settings.mustChange.title")}</p>
            <p className="mt-1 text-sm">{t("settings.mustChange.body")}</p>
          </div>
        )}
        <Row id="password" title={acct.hasPassword ? t("settings.password.title") : t("settings.password.titleAdd")}
          lead={acct.hasPassword ? t("settings.password.lead") : t("settings.password.leadAdd")}>
          <PasswordForm hasPassword={acct.hasPassword} />
        </Row>
        <Row id="passkeys" title={t("settings.passkeys.title")} flush lead={t("settings.passkeys.lead")}>
          <PasskeyList passkeys={pks} />
        </Row>
        <Row id="sessions" title={t("settings.sessions.title")} flush
          lead={<>{t("settings.sessions.lead")} {pks.length
            ? t("settings.sessions.summary", { passkeys: t("settings.sessions.passkeyCount", { count: pks.length }), devices })
            : t("settings.sessions.summaryNoPasskeys", { devices })}</>}>
          <SessionList sessions={sessions} />
        </Row>
      </Group>

      {current && (
        <Group id="graph">
          <Row id="graph-h" title={t("settings.graph.title")} lead={t("settings.graph.lead", { name: current.name })}>
            <GraphSettings g={{
              id: current.id, name: current.name, color: current.color, kind: current.kind, isFamily: current.isFamily,
              canEdit: current.myRole === "owner", memberCount: current.memberCount, ownerName: owner?.name ?? null,
            }} />
          </Row>
        </Group>
      )}

      {parent && (
        <Group id="household">
          <Row id="household-h" title={t("settings.household.title")} lead={t("settings.household.lead", { home })}>
            <p>{t("settings.household.summary", { people: t("settings.household.people", { count: members.length }), home })}</p>
            {pending > 0 && (
              <p className="mt-2 flex items-center gap-2 text-sm text-warn">
                <Badge tone="warn">{pending}</Badge>{t("settings.household.waiting", { count: pending })}
              </p>
            )}
            <div className="mt-4 space-y-1">
              <Onward href="/settings/family" title={t("settings.household.manage")} />
              <Onward href="/settings/audit" title={t("settings.household.audit")} hint={t("settings.household.auditHint")} />
            </div>
          </Row>
        </Group>
      )}

      {canUseAssistantTools(v) && (
        <Group id="assistant">
          <Row id="assistant-h" title={t("settings.assistant.title")} lead={t("settings.assistant.lead")}>
            <div className="space-y-1">
              <Onward href="/automations?view=settings#settings" title={t("settings.assistant.open")} hint={t("settings.assistant.openHint")} />
              <Onward href="/memory" title={t("settings.assistant.memory")} hint={t("settings.assistant.memoryHint")} />
            </div>
          </Row>
        </Group>
      )}

      {v.role !== "guest" && v.role !== "child" && (
        <Group id="connections">
          <Row id="connections-h" title={t("settings.connections.title")} lead={t("settings.connections.lead")}>
            <Onward href="/connections" title={t("settings.connections.open")} />
            <Onward href="/settings/ai-apps" title={t("mcpServer.nav")} hint={t("mcpServer.setup.lead")} />
          </Row>
        </Group>
      )}

      <Group id="data">
        <Row id="data-h" title={t("settings.data.title")} lead={t("settings.data.lead")}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-[52ch] text-sm text-muted">{t("settings.data.exportHint")}</p>
            <a href="/api/settings/export" download className={buttonClass("secondary")}>
              <Download size={16} aria-hidden />{t("settings.data.export")}
            </a>
          </div>
          <div className="mt-5 flex flex-wrap items-start justify-between gap-3 border-t border-line pt-5">
            <div className="min-w-0 max-w-[52ch]">
              <p className="font-medium">{t("settings.data.deleteTitle")}</p>
              <p className="mt-0.5 text-sm text-muted">{v.role === "owner" ? t("settings.data.deleteHintOwner") : t("settings.data.deleteHint")}</p>
            </div>
            <Button variant="danger" disabled>{t("settings.data.delete")}</Button>
          </div>
        </Row>
      </Group>
    </>
  );
}
