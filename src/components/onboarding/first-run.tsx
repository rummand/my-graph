"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, BellRing, Brain, Check, MessageCircle, Quote, ShieldCheck } from "lucide-react";
import { Button, Select } from "@/components/ui";
import type { defaultHeartbeat } from "@/lib/briefs/assistant-home";
import { useT, type TFn } from "@/lib/i18n/client";
import { Switch } from "./switch";

type Settings = { dailySuggestionCap: number };

export type FirstRunProps = {
  graphName: string;
  /** The family graph, or a graph made for one person or purpose ("For Sara", "Work"). */
  isFamily: boolean;
  /** Graph viewers can't create automations, so the check-in switch is hidden for them. */
  canWrite: boolean;
  settings: Settings;
  examples: string[];
  tip: { before: string; after: string };
  heartbeat: ReturnType<typeof defaultHeartbeat>;
  capChoices: readonly number[];
};

const ask = (q: string) => `/chat?q=${encodeURIComponent(q)}`;
const DISMISS_KEY = "mg:first-run-done:";

async function send(t: TFn, url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : t("onboarding.error.save"));
  return data;
}

/** Finds the id in `{ automation: { id } }`, `{ id }` or `{ automations: [...] }` shapes. */
function heartbeatFrom(data: Record<string, unknown>): { id: string; enabled: boolean } | null {
  const list = Array.isArray(data.automations) ? data.automations : data.automation ? [data.automation] : data.heartbeat ? [data.heartbeat] : [data];
  for (const a of list as Record<string, unknown>[]) {
    if (a && typeof a.id === "string" && (a.trigger === "heartbeat" || list.length === 1)) return { id: a.id, enabled: a.enabled !== false };
  }
  return null;
}

/**
 * First visit to a graph (Scout's onboarding): what the assistant does here, the defaults stated plainly (memory is
 * looked after by the Brain Keeper, facts always wait for a person), an option to turn on daily check-ins, three
 * example questions from the graph's own data, and a "be specific" tip. "Done" records it so this never shows again in
 * this graph. Family wording only in a family graph.
 */
export function FirstRun(p: FirstRunProps & { graphId: string }) {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [settings, setSettings] = useState<Settings>(p.settings);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkIn, setCheckIn] = useState<{ id: string; enabled: boolean } | null>(null);

  useEffect(() => {
    try { if (sessionStorage.getItem(DISMISS_KEY + p.graphId)) setHidden(true); } catch { /* storage blocked */ }
    if (!p.canWrite) return;
    let live = true;
    const read = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    read("/api/automations/heartbeat").then((own) => {
      if (!live) return;
      const hb = own?.heartbeat as Record<string, unknown> | null | undefined;
      if (hb && typeof hb.id === "string") setCheckIn({ id: hb.id, enabled: hb.enabled !== false });
    });
    return () => { live = false; };
  }, [p.graphId, p.canWrite]);

  async function patchSettings(patch: Partial<Settings>, key: string) {
    const before = settings;
    setSettings({ ...settings, ...patch });
    setSaving(key); setError(null);
    try { await send(t, "/api/assistant-settings", "PATCH", patch); }
    catch (e) { setSettings(before); setError(e instanceof Error ? e.message : t("onboarding.error.save")); }
    finally { setSaving(null); }
  }

  async function toggleCheckIn(on: boolean) {
    setSaving("checkin"); setError(null);
    try {
      // One check-in per person per graph; this address creates it the first time it is switched on.
      const made = await send(t, "/api/automations/heartbeat", "PATCH", checkIn ? { enabled: on } : { enabled: on, config: p.heartbeat.config });
      setCheckIn(heartbeatFrom(made) ?? { id: checkIn?.id ?? "", enabled: on });
    } catch (e) {
      setError(e instanceof TypeError ? t("onboarding.error.offline") : e instanceof Error ? e.message : t("onboarding.error.save"));
    } finally { setSaving(null); }
  }

  async function finish() {
    setSaving("done"); setError(null);
    try { await send(t, "/api/assistant-settings", "PATCH", { onboarded: true }); }
    catch { /* Hide it anyway for this visit; it will ask again next time if the save didn't land. */ }
    try { sessionStorage.setItem(DISMISS_KEY + p.graphId, "1"); } catch { /* ignore */ }
    setSaving(null);
    setHidden(true);
  }

  const checkInOn = !!checkIn?.enabled;
  const intro = p.isFamily ? t("onboarding.introFamily") : t("onboarding.intro", { graph: p.graphName });

  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.section
          key="first-run"
          aria-labelledby="first-run-title"
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8 overflow-hidden rounded-lg bg-surface"
        >
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="first-run-title" className="text-lg font-semibold tracking-[-0.01em]">
                {step === 1 ? (p.isFamily ? t("onboarding.titleFamily") : t("onboarding.title", { graph: p.graphName })) : t("onboarding.tryTitle")}
              </h2>
              <p className="text-sm text-muted tabular-nums">{t("onboarding.step", { step, total: 2 })}</p>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {step === 1 ? (
                <motion.div key="s1" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.18 }}>
                  <p className="mt-1.5 max-w-[68ch] text-muted">{intro}</p>

                  <div className="mt-5 grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <div>
                      <h3 className="text-sm font-medium text-muted">{t("onboarding.canDo")}</h3>
                      <ul className="mt-2 space-y-2.5">
                        <li className="flex gap-2.5"><MessageCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />{t("onboarding.canAnswer")}</li>
                        <li className="flex gap-2.5"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />{t(p.isFamily ? "onboarding.canSuggestFamily" : "onboarding.canSuggest")}</li>
                        <li className="flex gap-2.5"><BellRing aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />{t("onboarding.canCheckIn")}</li>
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-sm font-medium text-muted">{t("onboarding.settingsTitle")}</h3>
                      <ul className="mt-1">
                        <li className="flex items-start gap-3 border-b border-line/70 py-2.5">
                          <Brain aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                          <div className="min-w-0">
                            <p>{t("onboarding.memory.label")} <span className="font-medium">{t("onboarding.memory.value")}</span></p>
                            <p className="text-sm text-muted">
                              {t(p.isFamily ? "onboarding.memory.hintFamily" : "onboarding.memory.hint")}{" "}
                              <Link href="/memory" className="text-accent hover:underline">{t("onboarding.memory.link")}</Link>
                            </p>
                          </div>
                        </li>
                        <li className="flex items-start gap-3 border-b border-line/70 py-2.5">
                          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                          <div className="min-w-0">
                            <p>{t("onboarding.facts.label")} <span className="font-medium">{t("onboarding.facts.value")}</span></p>
                            <p className="text-sm text-muted">{t("onboarding.facts.hint")}</p>
                          </div>
                        </li>
                        {p.canWrite && (
                          <li className="flex items-center justify-between gap-4 border-b border-line/70 py-2.5">
                            <div className="min-w-0">
                              <p>{t("onboarding.checkIn.label")} <span className="font-medium">{checkInOn ? t("onboarding.checkIn.on") : t("onboarding.checkIn.off")}</span></p>
                              <p className="text-sm text-muted">
                                {checkInOn ? t(p.isFamily ? "onboarding.checkIn.hintOnFamily" : "onboarding.checkIn.hintOn") : t("onboarding.checkIn.hintOff")}
                              </p>
                            </div>
                            <Switch label={t("onboarding.checkIn.switch")} checked={checkInOn} busy={saving === "checkin"} disabled={!!saving} onChange={toggleCheckIn} />
                          </li>
                        )}
                        <li className="flex items-center justify-between gap-4 py-2.5">
                          <div className="min-w-0">
                            <p>{t("onboarding.cap.before")} <span className="font-medium tabular-nums">{settings.dailySuggestionCap}</span> {t("onboarding.cap.after", { count: settings.dailySuggestionCap })}</p>
                            <p className="text-sm text-muted">{t("onboarding.cap.hint")}</p>
                          </div>
                          <div className="w-20 shrink-0"><Select aria-label={t("onboarding.cap.label")} value={settings.dailySuggestionCap} disabled={!!saving}
                            onChange={(e) => patchSettings({ dailySuggestionCap: Number(e.target.value) }, "cap")}>
                            {[...new Set([...p.capChoices, settings.dailySuggestionCap])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
                          </Select></div>
                        </li>
                      </ul>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="s2" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.18 }}>
                  <p className="mt-1.5 max-w-[68ch] text-muted">
                    {p.isFamily ? t("onboarding.questionsFamily") : t("onboarding.questions", { graph: p.graphName })}
                  </p>
                  <div className="mt-5 grid gap-x-10 gap-y-6 lg:grid-cols-2">
                    <ul className="-mx-2">
                      {p.examples.map((q) => (
                        <li key={q}>
                          <Link href={ask(q)} className="group flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-surface-2">
                            <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
                            <span>{q}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <div className="rounded-lg bg-surface-2 p-4">
                      <h3 className="flex items-center gap-2 font-medium"><Quote aria-hidden className="size-4 text-muted" />{t("onboarding.tip.title")}</h3>
                      <p className="mt-1 text-sm text-muted">{t("onboarding.tip.body")}</p>
                      <dl className="mt-3 space-y-2 text-sm">
                        <div className="flex gap-3"><dt className="w-20 shrink-0 text-muted">{t("onboarding.tip.instead")}</dt><dd className="text-muted line-through decoration-muted/40">{p.tip.before}</dd></div>
                        <div className="flex gap-3"><dt className="w-20 shrink-0 text-muted">{t("onboarding.tip.try")}</dt><dd><Link href={ask(p.tip.after)} className="hover:underline">{p.tip.after}</Link></dd></div>
                      </dl>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              {step === 1 ? (
                <>
                  <Button onClick={() => setStep(2)}>{t("onboarding.next")}<ArrowRight aria-hidden className="size-4" /></Button>
                  <Button variant="ghost" onClick={finish} disabled={saving === "done"}>{t("onboarding.skip")}</Button>
                </>
              ) : (
                <>
                  <Button onClick={finish} disabled={saving === "done"}><Check aria-hidden className="size-4" />{saving === "done" ? t("common.saving") : t("onboarding.done")}</Button>
                  <Button variant="ghost" onClick={() => setStep(1)}>{t("common.back")}</Button>
                </>
              )}
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <p className="ml-auto text-sm text-muted">{t("onboarding.later")}</p>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
