import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { cachedBriefFor, loadToday, toBriefInput } from "@/lib/briefs";
import { loadAssistantHome } from "@/lib/briefs/assistant";
import {
  alwaysAllowLabel, buildOnboardingExamples, buildSuggestedQuestions, canWriteInGraph, defaultHeartbeat, hrefsAssistant,
  specificTip, suggestionOriginLabel, suggestionPreview, SUGGESTION_CAP_CHOICES, SUGGESTION_KIND_LABEL, TODAY_SUGGESTION_LIMIT,
  type QuestionInput, type SuggestionKindName,
} from "@/lib/briefs/assistant-home";
import { ageLabel, formatLongDate, greetingFor } from "@/lib/briefs/dates";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { FirstRun } from "@/components/onboarding/first-run";
import { AssistantActivity } from "@/components/today/activity";
import { NeedsAttention } from "@/components/today/attention";
import { TodayBoard } from "@/components/today/board";
import { BriefCard } from "@/components/today/brief-card";
import { WaitingForYou, type InboxItem } from "@/components/today/inbox";
import { QuickActions } from "@/components/today/quick-actions";
import { ReadyWhenYouAre } from "@/components/today/ready";
import { RecentlyAdded } from "@/components/today/recent";
import { hrefs } from "@/components/today/section";
import type { Lane } from "@/components/today/week";

export const metadata: Metadata = { title: "Today · My Graph" };
export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const viewer = await requireUser();
  const now = new Date();
  const [data, assistant] = await Promise.all([loadToday(viewer, now), loadAssistantHome(viewer)]);
  const { tz } = data;
  const firstName = viewer.name.split(/\s+/)[0] || viewer.name;
  const kids = data.children.ok ? data.children.data : [];

  // One row per child on the week strip, in their own colour, then the whole family.
  const lanes: Lane[] = kids.map((c) => ({
    key: c.userId, colorId: c.personNodeId ?? c.userId, name: c.name,
    href: c.personNodeId ? hrefs.node(c.personNodeId) : null, age: ageLabel(c.age),
    personNodeId: c.personNodeId, userId: c.userId,
  }));
  // Outside the family graph there is no "family": the row is simply everything in this graph.
  const inFamily = viewer.graphKind === "family";
  const family: Lane = { key: "family", colorId: null, name: inFamily ? "Whole family" : "Everything", href: null,
    age: inFamily ? "Everything else" : `In ${viewer.graphName}`, personNodeId: null, userId: null };

  const people = kids.filter((c) => c.personNodeId).map((c) => ({ personNodeId: c.personNodeId!, name: c.name }));
  if (viewer.personNodeId && !people.some((p) => p.personNodeId === viewer.personNodeId)) {
    people.unshift({ personNodeId: viewer.personNodeId, name: `${firstName} (you)` });
  }

  // What the assistant offers, written from this graph's own data.
  const briefInput = toBriefInput(viewer, data);
  const questionInput: QuestionInput = {
    now, tz, graphKind: viewer.graphKind,
    children: briefInput.children,
    events: briefInput.events.map((e) => ({ label: e.label, startAt: e.startAt, people: e.people })),
    reminders: briefInput.reminders.map((r) => ({ title: r.title, dueAt: r.dueAt, about: r.about })),
    sources: data.recentSources.ok ? data.recentSources.data.map((s) => ({ title: s.title, createdAt: s.createdAt, kind: s.kind })) : [],
  };
  const questions = buildSuggestedQuestions(questionInput, 4);
  const canWrite = canWriteInGraph(viewer);
  const inbox: InboxItem[] = (assistant.suggestions ?? []).map((s) => ({
    id: s.id, title: s.title,
    why: s.body && s.payload && Object.keys(s.payload).length ? s.body : null,
    kindLabel: SUGGESTION_KIND_LABEL[s.kind as SuggestionKindName] ?? "Suggestion",
    origin: suggestionOriginLabel({ origin: s.origin, createdAt: new Date(s.createdAt) }, now, tz),
    alwaysLabel: alwaysAllowLabel(s.kind),
    preview: suggestionPreview({ body: s.payload && Object.keys(s.payload).length ? null : s.body, payload: s.payload ?? {} }, tz),
    citations: s.citations ?? [],
  }));
  const firstRun = assistant.enabled && assistant.settingsLoaded && !assistant.settings.onboardedAt;

  return (
    <div>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{greetingFor(now, tz)}, {firstName}</h1>
          <p className="mt-1.5 text-muted">{formatLongDate(now, tz)}</p>
        </div>
        <QuickActions />
      </header>

      <GraphWelcome viewer={viewer} full />

      {firstRun && (
        <FirstRun
          graphId={viewer.graphId}
          graphName={viewer.graphName}
          isFamily={inFamily}
          canWrite={canWrite}
          settings={{ autoSaveMemories: assistant.settings.autoSaveMemories, dailySuggestionCap: assistant.settings.dailySuggestionCap }}
          examples={buildOnboardingExamples(questionInput)}
          tip={specificTip(questionInput)}
          heartbeat={defaultHeartbeat(tz)}
          capChoices={SUGGESTION_CAP_CHOICES}
        />
      )}

      {/* On phones the side column comes last, so decisions waiting for you move up above the week. */}
      {assistant.enabled && inbox.length > 0 && (
        <div className="mb-8 lg:hidden">
          <WaitingForYou id="waiting-m" items={inbox} limit={TODAY_SUGGESTION_LIMIT} seeAllHref={hrefsAssistant.inbox} readOnly={!canWrite} />
        </div>
      )}

      <TodayBoard
        tz={tz}
        nowIso={now.toISOString()}
        lanes={lanes}
        family={family}
        laneNote={data.children.ok ? null : "Couldn't load the children, so everything shows on the family row."}
        events={data.events.ok ? data.events.data : []}
        eventsFailed={!data.events.ok}
        reminders={data.reminders.ok ? data.reminders.data : []}
        remindersFailed={!data.reminders.ok}
        people={people}
        brief={
          <>
            <BriefCard initial={cachedBriefFor(viewer, now)} tz={tz} />
            <ReadyWhenYouAre
              questions={questions}
              recipes={assistant.enabled && assistant.recipes ? assistant.recipes.map((r) => ({ id: r.id, name: r.name, description: r.description })) : null}
            />
          </>
        }
        side={
          <>
            {assistant.enabled && inbox.length > 0 && (
              <div className="hidden lg:block">
                <WaitingForYou items={inbox} limit={TODAY_SUGGESTION_LIMIT} seeAllHref={hrefsAssistant.inbox} readOnly={!canWrite} />
              </div>
            )}
            <NeedsAttention data={data} />
            {assistant.enabled && <AssistantActivity activity={assistant.activity} now={now} tz={tz} />}
            <RecentlyAdded data={data} now={now} tz={tz} />
          </>
        }
      />
    </div>
  );
}
