/**
 * CONTRACT: run the assistant without a chat window (automations, heartbeat, recipes on Today).
 * Owned by the assistant workstream; signature fixed.
 *
 * mode "unattended" is Scout's stricter policy: it may only read and *propose* (via addSuggestion); it never writes
 * facts, shares, changes visibility or messages anyone. Steps that would need approval are listed in `skipped`.
 * "interactive" (a person pressed Run) gets the normal prompt, but a headless run still has nobody to click
 * Approve, so it too only proposes. Works degraded when mux is down: a deterministic summary of what it found.
 *
 * The web: when the prompt needs the outside world (a URL, "look up", opening hours, news…) and the owner may use
 * the web (capability "web"), the run searches and reads like the chat does: pages are saved as web sources with
 * provenance and cited, facts they state about the graph become one change set for a person to deliver, and each
 * step shows in the run's history. A run has a budget of 3 searches and 5 page reads (shared by every call with
 * the same run id). A check-in only uses the web when its prompt asks for it outright.
 *
 * Connected services (MCP): read-only tools only — nobody is there to approve a tool that changes something, so
 * those are never offered. Clients' and patients' material is used only while their consent covers analysis.
 */
import type { Viewer } from "@/lib/auth";
import type { AssistantStep, Citation } from "@/db/schema";
import { scopeOf } from "@/lib/graphs/pure";
import * as mux from "@/lib/mux";
import { markMemoriesUsed, memoryContext, type Memory } from "@/lib/memory";
import { addSuggestion, DEFAULT_SETTINGS, getAssistantSettings, webAllowed } from "@/lib/automations";
import * as gbrain from "@/lib/gbrain";
import { getMeta } from "@/lib/meta";
import {
  budgetForRun, extractUrls, needsWeb, proposeWebFacts, research, spendWeb, webAllowance, webHints, RUN_WEB_LIMITS,
  type FactNode, type Research,
} from "@/lib/web";
import { memoryAllowedFor, resolveNode } from "./apply";
import { parseClarify } from "./clarify";
import { dropUnknownCitations, extractCitations, numberContext, selectItems } from "./context";
import { longDay, timeZone } from "./dates";
import { degradedAnswer, deterministicSummary, firstSentence, type DegradedReason } from "./fallback";
import { planUnattended, skippedLine, suggestionOrigin } from "./policy";
import { buildMessages, type Tone } from "./prompt";
import { parseProposals, type Proposal } from "./proposals";
import { flagsFrom, offWords, retrieve, type Retrieval } from "./retrieve";
import { chooseRoute } from "./route";
import { voiceOf } from "./locale";
import { runMcpTools } from "./mcp";
import { clinicalConsentFilter, consentHint, consentStepLabel } from "@/lib/clinical/chat";
import { itemSteps, memoryStep, offStep, searchStep, webSteps } from "./steps";

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
  // Nobody is reading along: everything it writes is in the owner's language, about this graph by its kind.
  const voice = await voiceOf(v);
  const { t } = voice;
  if (!prompt) return { text: "", summary: t("chat.server.summary.emptyPrompt"), citations: [], steps, skipped: [], suggestionIds: [], degraded: false };

  const tz = timeZone();
  const now = new Date();
  const settings = await safe(getAssistantSettings(v), DEFAULT_SETTINGS, "settings");
  const flags = flagsFrom(settings.capabilities);
  const canWrite = scopeOf(v).canWrite;
  const memOk = memoryAllowedFor(v);

  const toolsPromise = safe(runMcpTools(v, { question: prompt, today: longDay(now, tz), readOnly: true, sensitive: false, traceId: input.runId, alwaysPlan: true }),
    { steps: [], context: "", approvals: [], hints: [] }, "MCP tools");
  const [found0, mem] = await Promise.all([
    safe(retrieve(v, prompt, { tz, now, flags }), { items: [], hits: 0, people: [] }, "retrieve"),
    memOk ? safe(memoryContext(v, { question: prompt, limit: 12 }), { text: "", items: [] as Memory[] }, "memory") : Promise.resolve({ text: "", items: [] as Memory[] }),
  ]);
  step(searchStep(flags, found0.hits));
  const consent = await safe(clinicalConsentFilter(v, found0.items), { kept: found0.items, excluded: [] }, "clinical consent");
  const found: Retrieval = consent.excluded.length ? { ...found0, items: consent.kept } : found0;
  step(consentStepLabel(consent.excluded) ? { kind: "other", label: consentStepLabel(consent.excluded)! } : null);
  const tools = await toolsPromise;
  for (const s of tools.steps) step(s);

  // The web, when the prompt needs it and the owner may use it; within the run's budget.
  const need = needsWeb(prompt, { graphHits: found.hits });
  const wantWeb = need.use && (input.origin !== "heartbeat" || need.why === "url" || need.why === "asked");
  const webOk = webAllowed(v, settings.capabilities);
  let web: Research | null = null;
  if (wantWeb && webOk) {
    const budget = budgetForRun(input.runId);
    const allowance = webAllowance(budget, { search: need.why !== "url", max: need.why === "url" ? Math.min(3, extractUrls(prompt).length) : 3 });
    if (!allowance) {
      step({ kind: "other", label: `Didn't use the web again: this run already used its ${RUN_WEB_LIMITS.searches} searches and ${RUN_WEB_LIMITS.reads} page reads` });
    } else {
      const avoid = found.items.filter((i) => i.sensitive || (i.level && i.level !== "normal")).map((i) => i.title);
      web = await safe(research(v, { question: prompt, avoid, conversationId: input.runId, maxPages: allowance.reads }), null, "web research");
      if (web) {
        spendWeb(budget, { searches: web.query ? 1 : 0, reads: web.pages.length });
        for (const s of webSteps(web)) step(s);
      }
    }
  } else if (wantWeb) {
    step({ kind: "other", label: "Didn't search the web (turned off for this account)" });
  }
  const webItems = web?.items ?? [];
  const webFirst = need.why === "url" || need.why === "asked" || need.why === "current";
  const items = selectItems(webFirst ? [...webItems, ...found.items] : [...found.items, ...webItems]);
  const ctx = numberContext(items);
  for (const s of itemSteps(items, flags)) step(s);
  step(memoryStep({
    rules: mem.items.filter((m) => m.kind === "rule").length,
    preferences: mem.items.filter((m) => m.kind === "preference").length,
    notes: mem.items.filter((m) => m.kind === "note" || m.kind === "fact").length,
  }, { family: voice.family }));
  if (mem.items.length) void markMemoriesUsed(v, mem.items.map((m) => m.id)).catch(() => {});
  const off = offWords(flags);
  step(offStep(off));

  const messages = buildMessages({
    viewerName: v.name, today: longDay(now, tz), timeZone: tz, context: ctx.text + tools.context, history: [], question: prompt,
    graphKind: v.graphKind, graphName: v.graphName, locale: voice.locale, answerInLocale: true,
    tone: (settings.tone as Tone) ?? "warm", memory: mem.text, off, canRemember: memOk && canWrite,
    unattended: input.mode === "unattended",
    hints: [
      "Start with one plain sentence that says what matters most (it is shown on its own as the run's summary), then the details. Don't start with \"Here is\".",
      ...(wantWeb ? webHints({ need: true, allowed: webOk, web, today: longDay(now, tz) }) : []),
      ...tools.hints,
      ...(consentHint(consent.excluded) ? [consentHint(consent.excluded)!] : []),
    ],
  });
  const webUsed = !!web?.pages.length;

  // Facts the pages state about things in the graph → one change set, read while the answer is written. Never applied.
  const factsPromise = webUsed && canWrite
    ? safe(webFactNodes(v, found).then((f) => proposeWebFacts(v, {
        question: prompt, query: web!.query, pages: web!.pages, nodes: f.nodes, relations: f.relations, existingEdges: f.edges,
        conversationId: input.runId, sensitive: ctx.sensitive,
      })), null, "web facts")
    : Promise.resolve(null);

  let raw: string;
  let degraded: DegradedReason | null = null;
  try {
    const r = await mux.complete({
      route: chooseRoute(prompt, { sensitive: ctx.sensitive, tools: webUsed, contextItems: items.length }), messages, maxTokens: 1500, temperature: 0.3,
      meta: { userId: v.id, agent: `my-graph:${input.origin}`, traceId: input.runId, sensitive: ctx.sensitive, graphId: v.graphId },
    });
    raw = r.text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  } catch (e) {
    degraded = reasonOf(e);
    raw = degradedAnswer(degraded, ctx, items, voice);
  }

  const skipped: string[] = [];
  const cl = parseClarify(raw);
  if (cl.clarify) skipped.push(t("chat.server.summary.askedNobody", { question: cl.clarify.question }));
  const parsed = parseProposals(cl.text);
  const text = dropUnknownCitations(parsed.text, ctx.citations.length);
  const citations = extractCitations(text, ctx.citations);

  // Scout's unattended policy: every write-like step becomes a suggestion; nothing is applied.
  const suggestionIds: string[] = [];
  if (!degraded && parsed.proposals.length) {
    if (!canWrite) {
      skipped.push(...parsed.proposals.map(() => t("chat.server.summary.cantWrite")));
    } else {
      const plan = planUnattended(parsed.proposals, { capabilities: settings.capabilities ?? {}, memoryAllowed: memOk, t, family: voice.family });
      skipped.push(...plan.skipped);
      for (const s of plan.suggest) {
        const payload = await withNodeIds(v, s.proposal, s.payload);
        const id = await safe(addSuggestion({
          graphId: v.graphId, userId: v.id, kind: s.kind, title: s.title, body: s.body, payload: { ...payload, locale: voice.locale }, citations,
          origin: suggestionOrigin(input.origin, input.runId), runId: input.runId, dedupeKey: s.dedupeKey,
        }), null, "addSuggestion");
        if (id) suggestionIds.push(id);
        skipped.push(skippedLine(s.proposal, !!id, t));
      }
    }
  }
  if (suggestionIds.length) step({ kind: "write", label: `Proposed ${suggestionIds.length} ${suggestionIds.length === 1 ? "change" : "changes"} for approval`, count: suggestionIds.length });
  const facts = await factsPromise;
  if (facts) {
    step({ kind: "write", label: `Proposed ${facts.count} ${facts.count === 1 ? "fact" : "facts"} from the web for you to deliver`, count: facts.count, changeSetId: facts.changeSetId });
    skipped.push(`Facts from the web: proposed as a change set, nothing added until you deliver it`);
  }

  const summary = degraded ? deterministicSummary(items, degraded, t) : firstSentence(text) || deterministicSummary(items, null, t);
  return { text, summary, citations, steps, skipped, suggestionIds, degraded: !!degraded };
}

/** Graph nodes the web pages may say something about: the people, places and things the run found (never sensitive ones). */
async function webFactNodes(v: Viewer, found: Retrieval): Promise<{ nodes: FactNode[]; relations: { key: string; label: string }[]; edges: string[] }> {
  const ids: string[] = [];
  for (const it of found.items) {
    if (it.kind === "node" && ["person", "place", "organization", "project", "topic", "thing"].includes(it.nodeType) && !it.sensitive && !ids.includes(it.nodeId)) ids.push(it.nodeId);
    if (ids.length >= 8) break;
  }
  if (!ids.length) return { nodes: [], relations: [], edges: [] };
  const meta = await getMeta(v);
  const nodes: FactNode[] = [];
  for (const id of ids) {
    const n = await gbrain.getNode(v, id).catch(() => null);
    if (!n || n.sensitive || n.type === "document" || n.type === "source") continue;
    const attributes = meta.attributesFor(n.type, n.kind).filter((a) => !a.sensitive && a.key !== "notes").map((a) => a.key);
    nodes.push({ id: n.id, label: n.label, type: n.type, summary: n.summary, props: n.props ?? {}, attributes });
  }
  const edges: string[] = [];
  for (const n of nodes.slice(0, 3)) {
    const hood = await gbrain.neighbourhood(v, n.id, 1).catch(() => ({ nodes: [], edges: [] as gbrain.GEdge[] }));
    for (const e of hood.edges) edges.push(`${e.fromId}|${e.relation}|${e.toId}`);
  }
  const types = new Set(nodes.map((n) => n.type));
  const relations = meta.relations
    .filter((r) => !r.hidden && (r.fromTypes.length === 0 || r.fromTypes.some((t) => types.has(t))))
    .map((r) => ({ key: r.key, label: r.label }));
  return { nodes, relations, edges };
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
