"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { PageHeader, Section } from "@/components/ui";
import type { AutomationsPageData } from "@/lib/automations/overview";
import { ActivityPanel } from "./activity-panel";
import { AutomationList } from "./automation-list";
import type { FormSeed } from "./automation-form";
import { HeartbeatPanel } from "./heartbeat-panel";
import { RecipesPanel } from "./recipes-panel";
import { RunDrawer } from "./run-drawer";
import { SettingsPanel } from "./settings-panel";
import { SuggestionCard } from "./suggestion-card";

/** Scout's Automations, Heartbeat and log for one graph: check-ins, automations, recipes, activity and settings. */
export function AutomationsApp({ data }: { data: AutomationsPageData }) {
  const router = useRouter();
  const params = useSearchParams();
  const [runId, setRunId] = useState<string | null>(params.get("run"));
  const [seed, setSeed] = useState<FormSeed | null>(null);
  const [inbox, setInbox] = useState(data.suggestions);

  useEffect(() => {
    const view = params.get("view");
    const id = view === "inbox" ? "inbox" : view === "activity" ? "activity" : view === "settings" ? "settings" : null;
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [params]);

  const openRun = useCallback((id: string) => setRunId(id), []);
  const closeRun = useCallback(() => {
    setRunId(null);
    if (params.get("run")) router.replace("/automations", { scroll: false });
  }, [params, router]);
  const refresh = useCallback(() => router.refresh(), [router]);

  const makeAutomation = (s: FormSeed) => {
    setSeed(s);
    requestAnimationFrame(() => document.getElementById("automations")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Automations"
        lead={`What the assistant does on its own in ${data.graphName}: check-ins, work on a schedule, and recipes you run again and again. It runs as you, sees only what you can see, and only suggests.`} />
      {!data.canCreate && (
        <p className="mb-6 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">You can look at this graph but not set up automations or recipes in it.</p>
      )}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-10">
          <Section title="Waiting for you" id="inbox">
            {inbox.length === 0 ? (
              <p className="text-sm text-muted">Nothing to decide. Suggestions from check-ins, automations and chats wait here until you approve or dismiss them.</p>
            ) : (
              <motion.ul layout className="space-y-2">
                <AnimatePresence initial={false}>
                  {inbox.map((s) => (
                    <motion.li key={s.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
                      <SuggestionCard s={s} onDone={(id) => setInbox((xs) => xs.filter((x) => x.id !== id))} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </motion.ul>
            )}
          </Section>

          <Section title="Check-ins" id="checkins">
            <HeartbeatPanel initial={data.heartbeat} canCreate={data.canCreate} cap={data.settings.dailySuggestionCap} onOpenRun={openRun} onChanged={refresh} />
          </Section>

          <Section title="Automations" id="automations">
            <AutomationList initial={data.automations} recipes={data.recipes} canCreate={data.canCreate} onOpenRun={openRun}
              formSeed={seed} onFormSeedUsed={() => setSeed(null)} />
          </Section>

          <Section title="Recipes" id="recipes">
            <RecipesPanel initial={data.recipes} canCreate={data.canCreate} onMakeAutomation={makeAutomation} onOpenRun={openRun} />
          </Section>
        </div>

        <aside className="min-w-0 space-y-10">
          <Section title="Activity" id="activity">
            <ActivityPanel initial={data.activity} onOpenRun={openRun} />
          </Section>
          <Section title="Assistant settings" id="settings">
            <SettingsPanel initial={data.settings} usage={data.usage} />
          </Section>
        </aside>
      </div>
      <RunDrawer runId={runId} onClose={closeRun} />
    </div>
  );
}
