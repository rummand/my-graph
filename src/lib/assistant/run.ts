/**
 * CONTRACT: run the assistant without a chat window (automations, heartbeat, recipes on Today).
 * Owned by the assistant workstream; signature fixed.
 *
 * mode "unattended" is Scout's stricter policy: it may only read and *propose* (via addSuggestion); it never writes
 * facts, shares, changes visibility or messages anyone. Steps that would need approval are listed in `skipped`.
 * "interactive" (a person pressed Run) gets the normal prompt, but a headless run still has nobody to click
 * Approve, so it too only proposes. Works degraded when mux is down: a deterministic summary of what it found.
 */
import type { Viewer } from "@/lib/auth";
import type { AssistantStep, Citation } from "@/db/schema";
import { scopeOf } from "@/lib/graphs/pure";
import * as mux from "@/lib/mux";
import { markMemoriesUsed, memoryContext, type Memory } from "@/lib/memory";
import { addSuggestion, DEFAULT_SETTINGS, getAssistantSettings } from "@/lib/automations";
import { memoryAllowedFor, resolveNode } from "./apply";
import { parseClarify } from "./clarify";
import { dropUnknownCitations, extractCitations, numberContext, selectItems } from "./context";
import { longDay, timeZone } from "./dates";
import { degradedAnswer, deterministicSummary, firstSentence, type DegradedReason } from "./fallback";
import { planUnattended, skippedLine, suggestionOrigin } from "./policy";
import { buildMessages, type Tone } from "./prompt";
import { parseProposals, type Proposal } from "./proposals";
import { flagsFrom, offWords, retrieve } from "./retrieve";
import { chooseRoute } from "./route";
import { itemSteps, memoryStep, offStep, searchStep } from "./steps";

export type TaskResult = {
  text: string; summary: string; citations: Citation[]; steps: AssistantStep[]; skipped: string[];
  suggestionIds: string[]; degraded: boolean;
};

type TaskInput = { prompt: string; mode: "unattended" | "interactive"; runId?: string; origin: "automation" | "heartbeat" | "recipe" };

function reasonOf(e: unknown): DegradedReason {
  if (e instanceof mux.MuxAuthError) return e.type === "not_configured" ? "not_configured" : "rejected";
  if (e instanceof mux.MuxUnavailableError) return "unreachable";
  return "error";
}

async function safe<T>(p: Promise<T>, fallback: T, what: string): Promise<T> {
  try { return await p; } catch (e) { console.error(`[assistant:run] ${what} failed:`, e); return fallback; }
}

export async function runTask(v: Viewer, input: TaskInput): Promise<TaskResult> {
  const t0 = Date.now();
  const steps: AssistantStep[] = [];
  const step = (s: AssistantStep | null) => { if (s) steps.push({ ...s, ms: Date.now() - t0 }); };
  const prompt = input.prompt.trim().slice(0, 4000);
  if (!prompt) return { text: "", summary: "There was nothing to do: the prompt is empty.", citations: [], steps, skipped: [], suggestionIds: [], degraded: false };

  const tz = timeZone();
  const now = new Date();
  const settings = await safe(getAssistantSettings(v), DEFAULT_SETTINGS, "settings");
  const flags = flagsFrom(settings.capabilities);
  const canWrite = scopeOf(v).canWrite;
  const memOk = memoryAllowedFor(v);

  const [found, mem] = await Promise.all([
    safe(retrieve(v, prompt, { tz, now, flags }), { items: [], hits: 0, people: [] }, "retrieve"),
    memOk ? safe(memoryContext(v, { question: prompt, limit: 12 }), { text: "", items: [] as Memory[] }, "memory") : Promise.resolve({ text: "", items: [] as Memory[] }),
  ]);
  step(searchStep(flags, found.hits));
  const items = selectItems(found.items);
  const ctx = numberContext(items);
  for (const s of itemSteps(items, flags)) step(s);
  step(memoryStep({
    rules: mem.items.filter((m) => m.kind === "rule").length,
    preferences: mem.items.filter((m) => m.kind === "preference").length,
    notes: mem.items.filter((m) => m.kind === "note" || m.kind === "fact").length,
  }));
  if (mem.items.length) void markMemoriesUsed(v, mem.items.map((m) => m.id)).catch(() => {});
  const off = offWords(flags);
  step(offStep(off));

  const messages = buildMessages({
    viewerName: v.name, today: longDay(now, tz), timeZone: tz, context: ctx.text, history: [], question: prompt,
    tone: (settings.tone as Tone) ?? "warm", memory: mem.text, off, canRemember: memOk && canWrite,
    unattended: input.mode === "unattended",
    hints: ["Start with one plain sentence that says what matters most (it is shown on its own as the run's summary), then the details. Don't start with \"Here is\"."],
  });

  let raw: string;
  let degraded: DegradedReason | null = null;
  try {
    const r = await mux.complete({
      route: chooseRoute(prompt, { sensitive: ctx.sensitive }), messages, maxTokens: 1500, temperature: 0.3,
      meta: { userId: v.id, agent: `my-graph:${input.origin}`, traceId: input.runId, sensitive: ctx.sensitive, graphId: v.graphId },
    });
    raw = r.text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  } catch (e) {
    degraded = reasonOf(e);
    raw = degradedAnswer(degraded, ctx, items);
  }

  const skipped: string[] = [];
  const cl = parseClarify(raw);
  if (cl.clarify) skipped.push(`Asked "${cl.clarify.question}": nobody was there to answer, so it went on with what it knew`);
  const parsed = parseProposals(cl.text);
  const text = dropUnknownCitations(parsed.text, ctx.citations.length);
  const citations = extractCitations(text, ctx.citations);

  // Scout's unattended policy: every write-like step becomes a suggestion; nothing is applied.
  const suggestionIds: string[] = [];
  if (!degraded && parsed.proposals.length) {
    if (!canWrite) {
      skipped.push(...parsed.proposals.map(() => "A suggested change: not suggested, this account can't add to the graph"));
    } else {
      const plan = planUnattended(parsed.proposals, { capabilities: settings.capabilities ?? {}, memoryAllowed: memOk });
      skipped.push(...plan.skipped);
      for (const s of plan.suggest) {
        const payload = await withNodeIds(v, s.proposal, s.payload);
        const id = await safe(addSuggestion({
          graphId: v.graphId, userId: v.id, kind: s.kind, title: s.title, body: s.body, payload, citations,
          origin: suggestionOrigin(input.origin, input.runId), runId: input.runId, dedupeKey: s.dedupeKey,
        }), null, "addSuggestion");
        if (id) suggestionIds.push(id);
        skipped.push(skippedLine(s.proposal, !!id));
      }
    }
  }
  if (suggestionIds.length) step({ kind: "write", label: `Proposed ${suggestionIds.length} ${suggestionIds.length === 1 ? "change" : "changes"} for approval`, count: suggestionIds.length });

  const summary = degraded ? deterministicSummary(items, degraded) : firstSentence(text) || deterministicSummary(items, null);
  return { text, summary, citations, steps, skipped, suggestionIds, degraded: !!degraded };
}

/** Resolve the names in a suggestion payload to node ids the viewer can see, so approving it later links the right people. */
async function withNodeIds(v: Viewer, p: Proposal, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const find = (name: string | null | undefined) => (name ? resolveNode(v, name).catch(() => null) : Promise.resolve(null));
  if (p.type === "propose_reminder") {
    const n = await find(p.aboutPerson);
    return n ? { ...payload, aboutNodeId: n.id } : payload;
  }
  if (p.type === "propose_fact") {
    const [from, to] = await Promise.all([find(p.from), find(p.to)]);
    return { ...payload, ...(from ? { fromId: from.id } : {}), ...(to ? { toId: to.id } : {}) };
  }
  if (p.type === "propose_memory") {
    const ids = (await Promise.all(p.about.map((a) => find(a)))).filter((n): n is NonNullable<typeof n> => !!n).map((n) => n.id);
    return { ...payload, aboutNodeIds: ids };
  }
  return payload;
}
