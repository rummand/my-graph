/**
 * One chat turn (server-only): settings → retrieve + recall memory → number the context → stream the answer from
 * mux → persist with citations, steps and any clarifying question → apply what the person chose to always allow.
 * The HTTP stream is SSE with these events:
 *   start       { conversationId, userMessageId, title, isNew }
 *   step        { step }                                  — "Searched the library", "Read 3 documents" …
 *   sources     { sources, route }                        — every numbered item the answer may cite
 *   sensitivity { level, badge }                          — the conversation now includes parents-only/private items
 *   delta       { text }                                  — visible answer text (proposals / clarify / page_action blocks held back)
 *   client_action { callId, name, title, danger, input }  — run a page action in the browser, then POST the outcome to
 *                                                           /api/chat/[id]/action; the answer waits (see ./page-actions)
 *   ping        {}                                        — keeps the stream open while a page action waits for the person
 *   done        { messageId, citations, proposals, clarify, steps, thoughtMs, stopped, model, route, requestId, degraded, title, mcpApprovals }
 *   error       { message }                               — only for failures before anything was saved
 */
import type { AssistantStep, Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import * as mux from "@/lib/mux";
import { formatSse } from "@/lib/mux/sse";
import { markMemoriesUsed, memoryContext, type Memory } from "@/lib/memory";
import { DEFAULT_SETTINGS, getAssistantSettings, webAllowed, type AssistantSettings } from "@/lib/automations";
import * as gbrain from "@/lib/gbrain";
import { getMeta } from "@/lib/meta";
import { recordMentions, resolveMentions } from "@/lib/mentions";
import { needsWeb, proposeWebFacts, research, type FactNode, type Research } from "@/lib/web";
import { webHints } from "@/lib/web/hints";
import { annotateProposal, decideProposal, memoryAllowedFor, ProposalError } from "./apply";
import { ambiguousNames, clarifyFromAmbiguity, parseClarify, type Clarify } from "./clarify";
import { turnsAfter } from "./compact";
import { citationsAnyOutside, citationsOnlyOutside, dropUnknownCitations, extractCitations, numberContext, selectItems } from "./context";
import { degradedAnswer, type DegradedReason } from "./fallback";
export { degradedAnswer, type DegradedReason };
import { longDay, timeZone } from "./dates";
import { autoApplyDecision, inferBasis } from "./policy";
import { answerTokens, buildMessages, cleanTitle, fallbackTitle, titleMessages, type HistoryTurn, type Tone } from "./prompt";
import * as wiki from "@/lib/pages";
import { parseProposals, ProposalStreamFilter, type ProposalView } from "./proposals";
import { flagsFrom, offWords, plainQuestion, retrieve, type Retrieval } from "./retrieve";
import { chooseRoute } from "./route";
import { isSensitivity, sensitivityBadge, type Sensitivity } from "./sensitivity";
import { foldState } from "./state";
import { voiceOf } from "./locale";
import { itemSteps, memoryStep, offStep, searchStep, webSteps } from "./steps";
import { checkAnswer, rulesForQuestion } from "@/lib/compliance/assistant";
import { clinicalConsentFilter, consentHint, consentStepLabel } from "@/lib/clinical/chat";
import type { McpApproval } from "@/lib/mcp-client";
import { runMcpTools, type McpUse } from "./mcp";
import { stripToolMarks } from "./mcp-plan";
import { pageHint, type ResolvedPage } from "./page-context";
import { ACTION_CLOSE, ACTION_OPEN, actionResultMessage, actionsPrompt, findActionCall, matchCall, MAX_ACTION_ROUNDS, stripActionBlocks, viewHints, type ActionManifest, type ClientActionOutcome, type PageSelection, type PageView } from "./page-actions";
import { awaitClientAction, WAIT_MS } from "./client-actions";
import type { ActionRecords } from "./state";
import { randomUUID } from "node:crypto";
import { autoCompact } from "./inbox";
import { addMessage, addState, conversationRows, createConversation, ownConversation, raiseConversationSensitivity, renameConversation, touchConversation } from "./store";

export class ChatInputError extends Error {
  constructor(public status: 400 | 404, message: string) { super(message); }
}

export type DoneEvent = {
  messageId: string; citations: Citation[]; proposals: ProposalView[]; model: string | null; route: string | null;
  requestId: string | null; degraded: null | DegradedReason; title: string | null;
  clarify: Clarify | null; steps: AssistantStep[]; thoughtMs: number; stopped: boolean;
  /** The final visible text (citation marks the context can't back are removed). */
  text: string;
  /** Facts read on the web about things in the graph, proposed as a change set (delivered by a person, never here). */
  changeSetId?: string | null;
  /** Tools at connected MCP servers that would change something: shown as approval cards under the answer. */
  mcpApprovals: McpApproval[];
  /** What the turn cost in tokens (every mux call it made), for measuring; the UI ignores it. */
  usage?: TurnUsage;
};

export type TurnUsage = {
  prompt: number; completion: number; cached: number; calls: number;
  answer: { prompt: number; completion: number; cached: number; rounds: number };
  /** Per agent ("my-graph:tools", "my-graph:chat-title" …). */
  agents: Record<string, { prompt: number; completion: number; cached: number; calls: number; ms: number }>;
};

/** The turn's calls summed; `answer` is the answer model alone (its rounds), the rest is titles and tool plans. */
export function turnUsage(calls: mux.UsageRecord[]): TurnUsage {
  const all = mux.sumUsage(calls);
  const a = mux.sumUsage(calls.filter((c) => c.agent === "my-graph:assistant"));
  if (calls.length && process.env.MG_DEBUG_TOKENS) console.log(`[assistant] turn tokens: prompt=${all.promptTokens} cached=${all.cachedTokens} completion=${all.completionTokens} calls=${all.calls}`);
  return {
    prompt: all.promptTokens, completion: all.completionTokens, cached: all.cachedTokens, calls: all.calls,
    answer: { prompt: a.promptTokens, completion: a.completionTokens, cached: a.cachedTokens, rounds: a.calls },
    agents: Object.fromEntries(Object.entries(all.byAgent).map(([k, x]) => [k, { prompt: x.promptTokens, completion: x.completionTokens, cached: x.cachedTokens, calls: x.calls, ms: x.ms }])),
  };
}

function reasonOf(e: unknown): DegradedReason {
  if (e instanceof mux.MuxAuthError) return e.type === "not_configured" ? "not_configured" : "rejected";
  if (e instanceof mux.MuxUnavailableError) return "unreachable";
  return "error";
}

async function safe<T>(p: Promise<T>, fallback: T, what: string): Promise<T> {
  try { return await p; } catch (e) { console.error(`[assistant] ${what} failed:`, e); return fallback; }
}

async function writeTitle(v: Viewer, question: string, sensitive: boolean, traceId: string): Promise<string> {
  try {
    const r = await Promise.race([
      mux.complete({ route: "fast", messages: titleMessages(question), maxTokens: 24, temperature: 0.2, meta: { userId: v.id, agent: "my-graph:chat-title", sensitive, graphId: v.graphId, traceId } }),
      new Promise<null>((res) => setTimeout(() => res(null), 8000)),
    ]);
    return r ? cleanTitle(r.text, question) : fallbackTitle(question);
  } catch {
    return fallbackTitle(question);
  }
}

/* ── Stop: the Stop button ends the model stream but keeps the answer so far (and its id). ─────────────── */

const g = globalThis as unknown as { __mgChatStops?: Map<string, AbortController> };
const stops = g.__mgChatStops ?? (g.__mgChatStops = new Map());
const stopKey = (userId: string, conversationId: string) => `${userId}:${conversationId}`;

/** Stop the answer being written in this conversation, if any. */
export function stopTurn(v: Viewer, conversationId: string): boolean {
  const c = stops.get(stopKey(v.id, conversationId));
  if (!c) return false;
  c.abort();
  return true;
}

/** Validate and set up a turn before any streaming starts (so bad ids answer 404, not a broken stream). */
export async function prepareTurn(v: Viewer, input: { conversationId?: string | null; question: string }) {
  let conversationId = input.conversationId ?? null;
  let isNew = false;
  let history: HistoryTurn[] = [];
  let sensitiveSoFar = false;
  let level: Sensitivity = "normal";
  let summary: string | null = null;
  let userText = input.question;
  let title = fallbackTitle(input.question);
  if (conversationId) {
    const c = await ownConversation(v, conversationId);
    if (!c) throw new ChatInputError(404, "That conversation doesn't exist or isn't yours.");
    title = c.title;
    level = isSensitivity(c.sensitivity) ? c.sensitivity : "normal";
    summary = c.summary ?? null;
    const rows = await conversationRows(c.id);
    const state = foldState(rows.filter((r) => r.role === "system").map((r) => r.content));
    sensitiveSoFar = state.sensitive;
    const visible = rows.filter((r) => r.role !== "system");
    // After "Compact this conversation", the summary stands in for the turns it covers. Answers that ran page actions
    // say which (the saved text has no trace of the calls, and the model must not learn to claim without calling).
    history = turnsAfter(visible, summary ? c.summaryUpToMessageId : null).map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.role === "assistant" && state.actions.has(r.id) ? `${r.content}\n\n${actionsNote(state.actions.get(r.id)!)}` : r.content,
    }));
    userText = [...visible.filter((r) => r.role === "user").map((r) => r.content), input.question].join("\n");
  } else {
    conversationId = (await createConversation(v, title)).id;
    isNew = true;
  }
  const user = await addMessage(conversationId, { role: "user", content: input.question });
  await touchConversation(conversationId);
  return { conversationId, isNew, history, sensitiveSoFar, level, summary, userText, title, userMessageId: user.id };
}

export type PreparedTurn = Awaited<ReturnType<typeof prepareTurn>>;

const memoryCounts = (items: Memory[]) => ({
  rules: items.filter((m) => m.kind === "rule").length,
  preferences: items.filter((m) => m.kind === "preference").length,
  notes: items.filter((m) => m.kind === "note" || m.kind === "fact").length,
});

export type TurnPage = {
  /** What was open when the question was asked (Ask window), already re-read as the viewer. */
  page?: ResolvedPage | null;
  /** What the open page lets the assistant do there (run in the browser, as the person). */
  actions?: ActionManifest[];
  view?: PageView | null;
  selection?: PageSelection | null;
};

export function runTurn(v: Viewer, turn: PreparedTurn, question: string, signal: AbortSignal, opts: TurnPage = {}): ReadableStream<Uint8Array> {
  const page = opts.page ?? null;
  const pageActions = opts.actions ?? [];
  const enc = new TextEncoder();
  const stopper = new AbortController();
  const key = stopKey(v.id, turn.conversationId);
  stops.get(key)?.abort();
  stops.set(key, stopper);
  const both = AbortSignal.any([signal, stopper.signal]);
  return new ReadableStream<Uint8Array>({
    // Every mux call of the turn (answer rounds, title, tool plan …) is metered; the sum goes out with `done`.
    start: (controller) => mux.meterUsage(async (usageCalls) => {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(formatSse(event, data))); } catch { closed = true; }
      };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };

      const t0 = Date.now();
      const steps: AssistantStep[] = [];
      const step = (s: AssistantStep | null) => { if (!s) return; const x = { ...s, ms: Date.now() - t0 }; steps.push(x); send("step", { step: x }); };
      const tz = timeZone();
      const now = new Date();
      let titlePromise: Promise<string> | null = null;
      try {
        send("start", { conversationId: turn.conversationId, userMessageId: turn.userMessageId, title: turn.title, isNew: turn.isNew });

        const [settings, voice] = await Promise.all([
          safe(getAssistantSettings(v), DEFAULT_SETTINGS as AssistantSettings, "settings"),
          voiceOf(v),
        ]);
        const flags = flagsFrom(settings.capabilities);
        const canWrite = scopeOf(v).canWrite;
        const memOk = memoryAllowedFor(v);

        // @mentions in the question: the nodes the person pointed at (readable ones only) lead the retrieval.
        const mentioned = await safe(resolveMentions(v, question), [], "mentions");
        // The page that's open leads too ("What's new with him?" on Bo's page), after anything @mentioned.
        const leadIds = [...mentioned.map((m) => m.nodeId), ...(page?.nodeId ? [page.nodeId] : [])];
        if (page) step({ kind: "other", label: `Looked at what you have open: ${page.title}` });
        if (mentioned.length) void recordMentions(v, { inType: "message", inId: turn.userMessageId, text: question }).catch(() => {});
        const plain = plainQuestion(question);
        const rulesPromise = safe(rulesForQuestion(v, plain), null, "corpus rules");
        // The person's connected services (MCP), planned from the question alone while the graph is searched.
        const lastAnswer = [...turn.history].reverse().find((h) => h.role === "assistant")?.content ?? null;
        const toolsPromise = safe(runMcpTools(v, {
          question: plain, today: longDay(now, tz), readOnly: !canWrite, sensitive: turn.sensitiveSoFar, recent: lastAnswer,
          traceId: turn.conversationId, signal: both, onStep: (s) => step(s),
        }), { steps: [], context: "", approvals: [], hints: [] } as McpUse, "MCP tools");

        // Retrieval and memory run together; each step is shown as soon as it finishes.
        const empty: Retrieval = { items: [], hits: 0, people: [] };
        const retrieval = safe(retrieve(v, question, { tz, now, flags, mentionIds: leadIds }), empty, "retrieve").then((r) => {
          step(searchStep(flags, r.hits));
          return r;
        });
        const recall = memOk
          ? safe(memoryContext(v, { question: plain, limit: 12 }), { text: "", items: [] as Memory[] }, "memory").then((m) => { step(memoryStep(memoryCounts(m.items), { family: voice.family })); return m; })
          : Promise.resolve({ text: "", items: [] as Memory[] });
        const [found0, mem] = await Promise.all([retrieval, recall]);
        // Clients and patients: their material is used only while their consent covers analysis.
        const consent = await safe(clinicalConsentFilter(v, found0.items), { kept: found0.items, excluded: [] }, "clinical consent");
        const found: Retrieval = consent.excluded.length ? { ...found0, items: consent.kept } : found0;
        const consentLabel = consentStepLabel(consent.excluded);
        if (consentLabel) step({ kind: "other", label: consentLabel });
        if (mem.items.length) void markMemoriesUsed(v, mem.items.map((m) => m.id)).catch(() => {});

        // The web, when the question needs the outside world and this person may use it.
        const need = needsWeb(question, { graphHits: found.hits });
        const webOk = webAllowed(v, settings.capabilities);
        let web: Research | null = null;
        if (need.use && webOk) {
          const avoid = found.items.filter((i) => i.sensitive || (i.level && i.level !== "normal")).map((i) => i.title);
          web = await safe(research(v, { question, avoid, conversationId: turn.conversationId, signal: both }), null, "web research");
          if (web) for (const s of webSteps(web)) step(s);
        } else if (need.use) {
          step({ kind: "other", label: "Didn't search the web (turned off for you)" });
        }
        const webFirst = need.why === "url" || need.why === "asked" || need.why === "current";
        const webItems = web?.items ?? [];
        const items = selectItems(webFirst ? [...webItems, ...found.items] : [...found.items, ...webItems]);
        const ctx = numberContext(items);
        const tools = await toolsPromise;
        for (const s of itemSteps(items, flags)) step(s);
        const off = offWords(flags);
        step(offStep(off));

        // Sensitivity: raised (never lowered) by what this answer draws on.
        const sensitive = ctx.sensitive || turn.sensitiveSoFar;
        if (ctx.sensitive && !turn.sensitiveSoFar) await addState(turn.conversationId, { type: "sensitive" });
        const level = await raiseConversationSensitivity(turn.conversationId, turn.level, ctx.level);
        if (level !== turn.level) send("sensitivity", { level, badge: sensitivityBadge(level) });

        const webUsed = !!web?.pages.length;
        const route = chooseRoute(question, { sensitive, tools: webUsed || !!tools.context, contextItems: items.length, followUp: turn.history.length > 0 });

        // Facts the pages state about things in the graph → a change set, read while the answer is written.
        const factsPromise = webUsed && canWrite && !stoppedEarly(both)
          ? safe(webFactNodes(v, found, mentioned.map((m) => m.nodeId)).then((f) => proposeWebFacts(v, {
              question: plain, query: web!.query, pages: web!.pages, nodes: f.nodes, relations: f.relations, existingEdges: f.edges,
              conversationId: turn.conversationId, sensitive,
            })), null, "web facts")
          : Promise.resolve(null);
        if (turn.isNew) titlePromise = writeTitle(v, question, sensitive, turn.conversationId);
        send("sources", { sources: ctx.citations, route });

        const amb = ambiguousNames(question, found.people);
        const hints = amb.map((a) => `"${a.name}" matches ${a.options.length} people ${voice.family ? "the family knows" : "in this graph"}: ${a.options.map((o) => o.label).join(", ")}. If it matters for the answer and the conversation doesn't say which, ask.`);
        if (mentioned.length) hints.push(`The person pointed at ${mentioned.map((m) => `"${m.label}"`).join(", ")} in the graph with @mentions: the question is about ${mentioned.length === 1 ? "that" : "those"}, not someone else with the same name.`);
        if (page) hints.push(pageHint(page));
        hints.push(...viewHints(opts.view, opts.selection));
        const ch = consentHint(consent.excluded);
        if (ch) hints.push(ch);
        hints.push(...tools.hints);
        hints.push(...webHints({ need: need.use, allowed: webOk, web, today: longDay(now, tz) }));
        // The rules the graph follows (its corpora), when the question needs them: answered with references.
        const ruleCtx = await rulesPromise;
        if (ruleCtx?.hint) {
          hints.push(ruleCtx.hint);
          step({ kind: "read", label: `Read ${ruleCtx.rules.length} ${ruleCtx.rules.length === 1 ? "rule" : "rules"} from the corpora`, count: ruleCtx.rules.length });
        }
        const messages = buildMessages({
          viewerName: v.name, today: longDay(now, tz), timeZone: tz, context: ctx.text + tools.context, history: turn.history, question,
          graphKind: v.graphKind, graphName: v.graphName, locale: voice.locale,
          tone: (settings.tone as Tone) ?? "warm", memory: mem.text, off, hints, summary: turn.summary, canRemember: memOk && canWrite,
          pageActions: actionsPrompt(pageActions), pageActionRules: true,
        });
        if (process.env.MG_DEBUG_PROMPT) dumpPrompt(turn.conversationId, messages);
        let raw = "";
        const actionCalls: { name: string; status: string; note: string | null }[] = [];
        /** The round being written now (added to `raw` when it ends, or when the stream breaks off). */
        let liveRound = "";
        let meta: Omit<mux.MuxResult, "text"> = { model: null, route: null, requestId: null };
        let degraded: DoneEvent["degraded"] = null;
        let stopped = false;
        try {
          // One round per page action: the model writes until it calls one, the browser runs it (after the person
          // approved a change), and the model reads the result and carries on.
          let convo = messages;
          actionCalls.length = 0;
          for (let round = 0; ; round++) {
            const filter = new ProposalStreamFilter();
            const roundStop = new AbortController();
            const gen = mux.stream({
              route, messages: convo, maxTokens: answerTokens(settings.tone), temperature: 0.3, signal: AbortSignal.any([both, roundStop.signal]),
              // affinity = the session: every round and every turn stays on one model, whose prompt cache holds the prefix.
              meta: { userId: v.id, agent: "my-graph:assistant", traceId: turn.conversationId, affinity: turn.conversationId, sensitive, graphId: v.graphId },
            });
            let roundRaw = "";
            let lead = raw.trim() ? "\n\n" : "";
            const emit = (text: string) => { if (!text) return; send("delta", { text: lead + text }); lead = ""; };
            let called = false;
            for (;;) {
              const r = await gen.next();
              if (r.done) { meta = r.value; break; }
              roundRaw += r.value;
              liveRound = roundRaw;
              emit(filter.push(r.value));
              if (pageActions.length && round < MAX_ACTION_ROUNDS && roundRaw.includes(ACTION_CLOSE)) {
                called = true;
                roundStop.abort();
                await gen.return(meta).catch(() => {});
                break;
              }
            }
            liveRound = "";
            // A call the model opened but didn't close before it stopped: still a call.
            if (!called && pageActions.length && round < MAX_ACTION_ROUNDS && roundRaw.includes(ACTION_OPEN) && !roundRaw.includes(ACTION_CLOSE)) {
              roundRaw += ACTION_CLOSE;
              called = true;
            }
            if (process.env.MG_DEBUG_ACTIONS) console.log("[assistant] round", round, JSON.stringify(roundRaw.slice(-600)));
            if (!called) {
              emit(filter.flush());
              raw += (raw.trim() && roundRaw.trim() ? "\n\n" : "") + stripActionBlocks(roundRaw);
              break;
            }
            const found = findActionCall(roundRaw);
            raw += (raw.trim() && found.before.trim() ? "\n\n" : "") + found.before;
            const blockEnd = roundRaw.indexOf(ACTION_CLOSE) + ACTION_CLOSE.length;
            const manifest = found.call ? matchCall(pageActions, found.call) : null;
            let outcome: ClientActionOutcome;
            if (!found.call || !manifest) {
              outcome = { status: "unavailable", error: found.call ? `There is no page action called ${found.call.name}.` : "The action block wasn't valid JSON." };
            } else {
              const callId = randomUUID();
              step({ kind: manifest.danger === "change" ? "write" : "other", label: `${manifest.danger === "change" ? "Asked to" : "On the page:"} ${manifest.title}` });
              send("client_action", { callId, name: manifest.name, title: manifest.title, danger: manifest.danger, input: found.call.input });
              outcome = await awaitClientAction(
                { callId, userId: v.id, conversationId: turn.conversationId },
                { timeoutMs: WAIT_MS[manifest.danger], signal: both, onTick: () => send("ping", {}) },
              );
              step({ kind: "other", label: actionStepLabel(manifest.title, outcome) });
            }
            actionCalls.push({
              name: found.call?.name.slice(0, 80) ?? "unknown", status: outcome.status,
              note: (outcome.status === "done" ? outcome.summary : outcome.status === "declined" ? null : outcome.error)?.slice(0, 400) ?? null,
            });
            convo = [
              ...convo,
              { role: "assistant", content: roundRaw.slice(0, blockEnd) },
              { role: "user", content: actionResultMessage(found.call ?? { name: "unknown" }, outcome, { last: round + 1 >= MAX_ACTION_ROUNDS }) },
            ];
          }
        } catch (e) {
          if (liveRound.trim()) { raw += (raw.trim() ? "\n\n" : "") + stripActionBlocks(liveRound); liveRound = ""; }
          if (both.aborted) {
            stopped = true;
          } else if (!raw.trim()) {
            degraded = reasonOf(e);
            if (degraded === "error") console.error("[assistant] mux stream failed:", e);
            raw = degradedAnswer(degraded, ctx, items, voice);
            send("delta", { text: raw });
          } else {
            console.error("[assistant] mux stream broke off:", e);
            const note = `\n\n_(${voice.t("chat.server.cutOff")})_`;
            raw = parseProposals(parseClarify(raw).text).text + note;
            send("delta", { text: note });
          }
          if (e instanceof mux.MuxError) meta = { model: null, route: null, requestId: e.requestId };
        }
        if (stopped) {
          raw = `${parseProposals(parseClarify(raw).text).text}\n\n_${voice.t("chat.stopped")}_`.trim();
        }

        // A clarifying question replaces proposals; when no model could ask, ask about an ambiguous name ourselves.
        const cl = parseClarify(raw);
        let clarify = stopped ? null : cl.clarify;
        if (!clarify && degraded && amb.length) clarify = clarifyFromAmbiguity(amb);
        const content = stripToolMarks(dropUnknownCitations(clarify ? parseProposals(cl.text).text : cl.text, ctx.citations.length));
        const parsed = parseProposals(content);
        const citations = extractCitations(parsed.text, ctx.citations);
        // The web change set: waited for a little while after the answer (it is read in parallel).
        let changeSetId: string | null = null;
        if (webUsed && !stopped && !degraded) {
          const facts = await Promise.race([factsPromise, new Promise<null>((res) => setTimeout(() => res(null), 20_000))]);
          if (facts) {
            changeSetId = facts.changeSetId;
            step({ kind: "write", label: `Proposed ${facts.count} ${facts.count === 1 ? "change" : "changes"} for approval`, count: facts.count, ...(facts.changeSetId ? { changeSetId: facts.changeSetId } : {}) });
          }
        }

        const thoughtMs = Date.now() - t0;
        const saved = await addMessage(turn.conversationId, {
          role: "assistant", content, citations, model: meta.model, route: meta.route ?? (degraded ? null : route), requestId: meta.requestId,
          steps, thoughtMs, clarify,
        });
        await touchConversation(turn.conversationId);
        if (actionCalls.length) await addState(turn.conversationId, { type: "actions", messageId: saved.id, calls: actionCalls.slice(0, 10) });
        const mcpApprovals = stopped ? [] : tools.approvals;
        if (mcpApprovals.length) await addState(turn.conversationId, { type: "mcp", messageId: saved.id, approvals: mcpApprovals });

        // Proposals: annotate (who'd see it, what it changes), then apply the ones the person always allows.
        const proposals: ProposalView[] = [];
        let existingWikiTitles: string[] | undefined;
        if (!stopped && !degraded) {
          const onlyOutside = citationsOnlyOutside(citations);
          const anyOutside = citationsAnyOutside(citations);
          for (const [i, p] of parsed.proposals.entries()) {
            const n = i + 1;
            if (p.type === "propose_memory" && !memOk) continue;
            // Never offer to start a page that already exists (or one that only differs by "project", "notes" …).
            if (p.type === "propose_wiki_note") {
              existingWikiTitles ??= await wiki.listPages(v, { limit: 200 }).then((ps) => ps.map((x) => wikiTitleKey(x.title))).catch(() => []);
              const k = wikiTitleKey(p.title);
              if (!k || existingWikiTitles.some((t) => t === k || (t.length > 3 && (t.includes(k) || k.includes(t))))) continue;
            }
            const basis = inferBasis(p, { userText: turn.userText, citedOnlyDocuments: onlyOutside, citedDocuments: anyOutside });
            const note = await annotateProposal(v, p, level);
            const view: ProposalView = { ...p, basis, n, status: "pending", result: null, auto: null, ...note };
            const d = autoApplyDecision(p, {
              mode: "interactive", canWrite, alwaysAllow: settings.alwaysAllow ?? [], autoSaveMemories: settings.autoSaveMemories,
              basis, widens: !!note.widens, capabilities: settings.capabilities ?? {}, question,
            });
            if (d.mode === "keeper") {
              // Memory is the Brain Keeper's: hand it over for its next run instead of asking now.
              await addState(turn.conversationId, { type: "proposal", messageId: saved.id, n, status: "queued", auto: null, why: d.why });
              view.status = "queued"; view.keeperNote = d.why;
            } else if (d.mode === "auto") {
              try {
                const out = await decideProposal(v, { conversationId: turn.conversationId, messageId: saved.id, n, action: "approve", auto: d.reason, basis });
                view.status = "approved"; view.result = out.result; view.auto = d.reason;
              } catch (e) {
                if (!(e instanceof ProposalError)) console.error("[assistant] auto-apply failed:", e);
              }
            }
            proposals.push(view);
          }
        }

        let title: string | null = null;
        if (titlePromise) {
          title = await titlePromise;
          if (title !== turn.title) await renameConversation(turn.conversationId, title);
        }
        const done: DoneEvent = {
          messageId: saved.id, citations, model: meta.model, route: meta.route ?? (degraded ? null : route), requestId: meta.requestId,
          degraded, title, proposals, clarify, steps, thoughtMs, stopped, text: parsed.text, changeSetId, mcpApprovals,
          usage: turnUsage(usageCalls),
        };
        send("done", done);
        // Compliance: the answer and its proposals against the graph's corpora, after the answer (never slows it).
        // The chat picks the result up from /api/compliance/findings; the step "Checked against N corpora" is added then.
        if (!stopped && !degraded) {
          // A long session: summarise its older turns now, so the next questions send a short, stable history.
          void autoCompact(v, turn.conversationId);
          void checkAnswer(v, saved.id, { corpusIds: ruleCtx?.named ? ruleCtx.corpora.map((c) => c.id) : null })
            .catch((e) => console.warn("[assistant] compliance check failed:", e instanceof Error ? e.message : e));
        }
      } catch (e) {
        console.error("[assistant] turn failed:", e);
        send("error", { message: "Something went wrong on our side while answering. Your question was saved; please try again." });
      } finally {
        if (stops.get(key) === stopper) stops.delete(key);
        close();
      }
    }),
  });
}

/** A page title reduced to what it is about: "EAM Platform Project notes" and "EAM platform" both become "eam platform". */
export function wikiTitleKey(title: string): string {
  const stop = new Set(["project", "projects", "page", "notes", "note", "wiki", "the", "a", "an", "about", "on", "om", "noter", "side", "projektet", "projekt"]);
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !stop.has(w)).join(" ");
}

const stoppedEarly = (s: AbortSignal) => s.aborted;

/** MG_DEBUG_PROMPT=1: each turn's messages to $TMPDIR/mg-prompts (to check the prefix stays byte-identical). */
function dumpPrompt(conversationId: string, messages: mux.MuxMessage[]) {
  void import("node:fs/promises").then(async (fs) => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/mg-prompts`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${conversationId}-${Date.now()}.json`, JSON.stringify(messages, null, 1));
  }).catch(() => {});
}


/** How an earlier answer's page actions read in the history the model gets. */
export function actionsNote(calls: NonNullable<ReturnType<ActionRecords["get"]>>): string {
  const list = calls.map((c) => `${c.name} → ${c.status}${c.note ? ` (${c.note.replace(/[\r\n]+/g, " ")})` : ""}`).join("; ");
  return `[Page actions this answer ran, with their results: ${list}. Anything not listed here was not done.]`;
}

/** The step saved with the answer: what happened to a page action. */
export function actionStepLabel(title: string, o: ClientActionOutcome): string {
  switch (o.status) {
    case "done": return o.summary ? `${title}: ${o.summary}` : `${title}: done`;
    case "declined": return `${title}: you said not now`;
    case "failed": return `${title}: didn't work (${o.error})`;
    case "unavailable": return `${title}: not available on this page any more`;
  }
}

/**
 * The graph nodes a web page might say something about: the ones the person @mentioned and the people, places,
 * organisations, projects and topics in the context — readable in this graph, not sensitive, at most 8 — with the
 * attribute keys their kind carries (sensitive attributes left out) and the relation types the graph allows.
 */
async function webFactNodes(v: Viewer, found: Retrieval, mentionIds: string[]): Promise<{ nodes: FactNode[]; relations: { key: string; label: string }[]; edges: string[] }> {
  const ids: string[] = [...mentionIds];
  for (const it of found.items) {
    if (it.kind === "node" && ["person", "place", "organization", "project", "topic", "thing"].includes(it.nodeType) && !it.sensitive && !ids.includes(it.nodeId)) ids.push(it.nodeId);
    if (ids.length >= 8) break;
  }
  const meta = await getMeta(v);
  const nodes: FactNode[] = [];
  const edges: string[] = [];
  for (const id of ids.slice(0, 8)) {
    const n = await gbrain.getNode(v, id).catch(() => null);
    if (!n || n.sensitive || n.type === "document" || n.type === "source") continue;
    const attributes = meta.attributesFor(n.type, n.kind).filter((a) => !a.sensitive && a.key !== "notes").map((a) => a.key);
    nodes.push({ id: n.id, label: n.label, type: n.type, summary: n.summary, props: n.props ?? {}, attributes });
  }
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
