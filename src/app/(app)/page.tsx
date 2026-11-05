import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { cachedBriefFor, loadToday, toBriefInput } from "@/lib/briefs";
import { loadAssistantHome } from "@/lib/briefs/assistant";
import {
  alwaysAllowLabel, buildOnboardingExamples, buildSuggestedQuestions, canWriteInGraph, defaultHeartbeat, hrefsAssistant,
  specificTip, suggestionKindLabel, suggestionOriginLabel, suggestionPreview, SUGGESTION_CAP_CHOICES, TODAY_SUGGESTION_LIMIT,
  type QuestionInput,
} from "@/lib/briefs/assistant-home";
import { ageLabel, formatLongDate, greetingFor } from "@/lib/briefs/dates";
import { loadKeyThings, type KeyThing } from "@/lib/briefs/queries";
import { listChangeSets, type ChangeSetView } from "@/lib/changes";
import { getPrefs, getT } from "@/lib/i18n";
import { templateFor } from "@/lib/templates";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { FirstRun } from "@/components/onboarding/first-run";
import { AssistantActivity } from "@/components/today/activity";
import { NeedsAttention } from "@/components/today/attention";
import { TodayBoard } from "@/components/today/board";
import { BriefCard } from "@/components/today/brief-card";
import { ProposedChanges } from "@/components/today/change-sets";
import { ConnectionsNeedYou } from "@/components/today/connections";
import { connectionsNeedingYou } from "@/lib/connectors";
import { WaitingForYou, type InboxItem } from "@/components/today/inbox";
import { KeyThings } from "@/components/today/key-things";
import { QuickActions } from "@/components/today/quick-actions";
import { ReadyWhenYouAre } from "@/components/today/ready";
import { RecentlyAdded } from "@/components/today/recent";
import { hrefs } from "@/components/today/section";
import { ComingUp } from "@/components/today/upcoming";
import { KeepInTouch } from "@/components/today/keep-in-touch";
import { CommitmentsToday } from "@/components/commitments/today";
import type { Lane } from "@/components/today/week";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("today.meta.title") };
}
export const dynamic = "force-dynamic";

async function safe<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[today] ${name} failed:`, err);
    return null;
  }
}

/**
 * Today follows the graph's template (src/lib/templates): which modules show, the example questions and the wording.
 * A family graph gets the children's week; any other graph gets what is coming up and its key people and projects.
 */
export default async function TodayPage() {
  const viewer = await requireUser();
  const now = new Date();
  const [{ locale, timeZone }, t] = await Promise.all([getPrefs(), getT()]);
  const template = templateFor(viewer);
  const show = new Set<string>(template.today);
  const inFamily = viewer.graphKind === "family";

  const [data, assistant, changeSets, keyThings, brokenConnections] = await Promise.all([
    loadToday(viewer, now, timeZone),
    loadAssistantHome(viewer),
    safe("change sets", () => listChangeSets(viewer, { status: "draft", limit: 5 })),
    inFamily ? Promise.resolve<KeyThing[] | null>([]) : safe("key people and projects", () => loadKeyThings(viewer)),
    safe("connections", () => connectionsNeedingYou(viewer)),
  ]);
  const { tz } = data;
  const firstName = viewer.name.split(/\s+/)[0] || viewer.name;
  const kids = inFamily && data.children.ok ? data.children.data : [];

  // Family graph: one row per child on the week strip, in their own colour, then the whole family.
  const lanes: Lane[] = kids.map((c) => ({
    key: c.userId, colorId: c.personNodeId ?? c.userId, name: c.name,
    href: c.personNodeId ? hrefs.node(c.personNodeId) : null, age: ageLabel(c.age, locale),
    personNodeId: c.personNodeId, userId: c.userId,
  }));
  const family: Lane = {
    key: "family", colorId: null, name: inFamily ? t("today.lane.family") : t("today.lane.everything"), href: null,
    age: inFamily ? t("today.lane.familySub") : t("today.lane.everythingSub", { graph: viewer.graphName }), personNodeId: null, userId: null,
  };

  const people = kids.filter((c) => c.personNodeId).map((c) => ({ personNodeId: c.personNodeId!, name: c.name }));
  if (viewer.personNodeId && !people.some((p) => p.personNodeId === viewer.personNodeId)) {
    people.unshift({ personNodeId: viewer.personNodeId, name: t("today.you", { name: firstName }) });
  }
  // Outside a family graph, reminders can be about the graph's key people too.
  for (const k of keyThings ?? []) {
    if (k.type === "person" && !people.some((p) => p.personNodeId === k.id)) people.push({ personNodeId: k.id, name: k.label });
  }

  // What the assistant offers, written from this graph's own data, with the template's examples when it is quiet.
  const briefInput = toBriefInput(viewer, data);
  const templatePrompts = template.prompts.map((p, i) => t(`today.templatePrompts.${template.kind}.${i}`, undefined, p));
  const questionInput: QuestionInput = {
    now, tz, graphKind: viewer.graphKind ?? "other", locale, templatePrompts,
    children: inFamily ? briefInput.children : [],
    events: briefInput.events.map((e) => ({ label: e.label, startAt: e.startAt, people: e.people })),
    reminders: briefInput.reminders.map((r) => ({ title: r.title, dueAt: r.dueAt, about: r.about })),
    sources: data.recentSources.ok ? data.recentSources.data.map((s) => ({ title: s.title, createdAt: s.createdAt, kind: s.kind })) : [],
  };
  const questions = buildSuggestedQuestions(questionInput, 4);
  const canWrite = canWriteInGraph(viewer);
  const graphKind = viewer.graphKind ?? "other";
  const inbox: InboxItem[] = (assistant.suggestions ?? []).map((s) => ({
    id: s.id, title: s.title,
    why: s.body && s.payload && Object.keys(s.payload).length ? s.body : null,
    kindLabel: suggestionKindLabel(s.kind, locale, graphKind),
    origin: suggestionOriginLabel({ origin: s.origin, createdAt: new Date(s.createdAt) }, now, tz, locale),
    alwaysLabel: alwaysAllowLabel(s.kind, locale, graphKind),
    preview: suggestionPreview({ body: s.payload && Object.keys(s.payload).length ? null : s.body, payload: s.payload ?? {} }, tz, locale),
    citations: s.citations ?? [],
  }));
  const firstRun = assistant.enabled && assistant.settingsLoaded && !assistant.settings.onboardedAt;
  const waiting = show.has("waiting") && assistant.enabled && inbox.length > 0;
  const pendingSets: ChangeSetView[] = (changeSets ?? []).filter((c) => c.status === "draft");
  const quickQuestion = inFamily ? t("today.quick.tomorrow") : t("today.quick.week");

  return (
    <div>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("today.greetingName", { greeting: greetingFor(now, tz, locale), name: firstName })}</h1>
          <p className="mt-1.5 text-muted">{formatLongDate(now, tz, locale)}</p>
        </div>
        {show.has("quick_actions") && <QuickActions question={quickQuestion} />}
      </header>

      <GraphWelcome viewer={viewer} full />

      {viewer.role !== "guest" && <CommitmentsToday viewer={viewer} tz={tz} now={now} />}

      {firstRun && (
        <FirstRun
          graphId={viewer.graphId}
          graphName={viewer.graphName}
          isFamily={inFamily}
          canWrite={canWrite}
          settings={{ dailySuggestionCap: assistant.settings.dailySuggestionCap }}
          examples={buildOnboardingExamples(questionInput)}
          tip={specificTip(questionInput)}
          heartbeat={defaultHeartbeat(tz, locale)}
          capChoices={SUGGESTION_CAP_CHOICES}
        />
      )}

      {/* On phones the side column comes last, so decisions waiting for you move up above the week. */}
      {brokenConnections && brokenConnections.length > 0 && <div className="mb-8"><ConnectionsNeedYou items={brokenConnections} /></div>}

      {(waiting || pendingSets.length > 0) && (
        <div className="mb-8 space-y-8 lg:hidden">
          {waiting && <WaitingForYou id="waiting-m" items={inbox} limit={TODAY_SUGGESTION_LIMIT} seeAllHref={hrefsAssistant.inbox} readOnly={!canWrite} />}
          <ProposedChanges sets={pendingSets} now={now} tz={tz} canDeliver={canWrite} />
        </div>
      )}

      <TodayBoard
        tz={tz}
        nowIso={now.toISOString()}
        week={inFamily && show.has("week")}
        top={inFamily ? undefined : (
          <div className="grid gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
            <ComingUp events={data.events.ok ? data.events.data : []} failed={!data.events.ok} now={now} tz={tz} />
            <KeyThings items={keyThings} />
          </div>
        )}
        lanes={lanes}
        family={family}
        laneNote={inFamily && !data.children.ok ? t("today.lane.childrenFailed") : null}
        events={data.events.ok ? data.events.data : []}
        eventsFailed={!data.events.ok}
        reminders={data.reminders.ok ? data.reminders.data : []}
        remindersFailed={!data.reminders.ok}
        people={people}
        isFamily={inFamily}
        brief={
          <>
            {show.has("brief") && <BriefCard initial={cachedBriefFor(viewer, now, { locale, tz })} tz={tz} isFamily={inFamily} />}
            {show.has("ready") && (
              <ReadyWhenYouAre
                questions={questions}
                recipes={assistant.enabled && assistant.recipes ? assistant.recipes.map((r) => ({ id: r.id, name: r.name, description: r.description })) : null}
              />
            )}
          </>
        }
        side={
          <>
            {waiting && (
              <div className="hidden lg:block">
                <WaitingForYou items={inbox} limit={TODAY_SUGGESTION_LIMIT} seeAllHref={hrefsAssistant.inbox} readOnly={!canWrite} />
              </div>
            )}
            {pendingSets.length > 0 && <div className="hidden lg:block"><ProposedChanges sets={pendingSets} now={now} tz={tz} canDeliver={canWrite} /></div>}
            {show.has("attention") && <NeedsAttention data={data} />}
            <KeepInTouch viewer={viewer} />
            {show.has("activity") && assistant.enabled && <AssistantActivity activity={assistant.activity} now={now} tz={tz} />}
            {show.has("recent") && <RecentlyAdded data={data} now={now} tz={tz} />}
          </>
        }
      />
    </div>
  );
}
