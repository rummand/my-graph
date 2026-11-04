/**
 * One chat turn (server-only): settings → retrieve + recall memory → number the context → stream the answer from
 * mux → persist with citations, steps and any clarifying question → apply what the person chose to always allow.
 * The HTTP stream is SSE with these events:
 *   start       { conversationId, userMessageId, title, isNew }
 *   step        { step }                                  — "Searched the library", "Read 3 documents" …
 *   sources     { sources, route }                        — every numbered item the answer may cite
 *   sensitivity { level, badge }                          — the conversation now includes parents-only/private items
 *   delta       { text }                                  — visible answer text (proposals / clarify blocks held back)
 *   done        { messageId, citations, proposals, clarify, steps, thoughtMs, stopped, model, route, requestId, degraded, title }
 *   error       { message }                               — only for failures before anything was saved
 */
import type { AssistantStep, Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import * as mux from "@/lib/mux";
import { formatSse } from "@/lib/mux/sse";
import { markMemoriesUsed, memoryContext, type Memory } from "@/lib/memory";
import { DEFAULT_SETTINGS, getAssistantSettings, type AssistantSettings } from "@/lib/automations";
import { annotateProposal, decideProposal, memoryAllowedFor, ProposalError } from "./apply";
import { ambiguousNames, clarifyFromAmbiguity, parseClarify, type Clarify } from "./clarify";
import { turnsAfter } from "./compact";
import { citationsAnyOutside, citationsOnlyOutside, dropUnknownCitations, extractCitations, numberContext, selectItems } from "./context";
import { degradedAnswer, type DegradedReason } from "./fallback";
export { degradedAnswer, type DegradedReason };
import { longDay, timeZone } from "./dates";
import { autoApplyDecision, inferBasis } from "./policy";
import { buildMessages, cleanTitle, fallbackTitle, titleMessages, type HistoryTurn, type Tone } from "./prompt";
import * as wiki from "@/lib/wiki";
import { parseProposals, ProposalStreamFilter, type ProposalView } from "./proposals";
import { flagsFrom, offWords, retrieve, type Retrieval } from "./retrieve";
import { chooseRoute } from "./route";
import { isSensitivity, sensitivityBadge, type Sensitivity } from "./sensitivity";
import { foldState } from "./state";
import { itemSteps, memoryStep, offStep, searchStep } from "./steps";
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
};

function reasonOf(e: unknown): DegradedReason {
  if (e instanceof mux.MuxAuthError) return e.type === "not_configured" ? "not_configured" : "rejected";
  if (e instanceof mux.MuxUnavailableError) return "unreachable";
  return "error";
}

async function safe<T>(p: Promise<T>, fallback: T, what: string): Promise<T> {
  try { return await p; } catch (e) { console.error(`[assistant] ${what} failed:`, e); return fallback; }
}

async function writeTitle(v: Viewer, question: string, sensitive: boolean): Promise<string> {
  try {
    const r = await Promise.race([
      mux.complete({ route: "fast", messages: titleMessages(question), maxTokens: 24, temperature: 0.2, meta: { userId: v.id, agent: "my-graph:chat-title", sensitive, graphId: v.graphId } }),
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
    sensitiveSoFar = foldState(rows.filter((r) => r.role === "system").map((r) => r.content)).sensitive;
    const visible = rows.filter((r) => r.role !== "system");
    // After "Compact this conversation", the summary stands in for the turns it covers.
    history = turnsAfter(visible, summary ? c.summaryUpToMessageId : null).map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
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

export function runTurn(v: Viewer, turn: PreparedTurn, question: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const stopper = new AbortController();
  const key = stopKey(v.id, turn.conversationId);
  stops.get(key)?.abort();
  stops.set(key, stopper);
  const both = AbortSignal.any([signal, stopper.signal]);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
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

        const settings: AssistantSettings = await safe(getAssistantSettings(v), DEFAULT_SETTINGS, "settings");
        const flags = flagsFrom(settings.capabilities);
        const canWrite = scopeOf(v).canWrite;
        const memOk = memoryAllowedFor(v);

        // Retrieval and memory run together; each step is shown as soon as it finishes.
        const empty: Retrieval = { items: [], hits: 0, people: [] };
        const retrieval = safe(retrieve(v, question, { tz, now, flags }), empty, "retrieve").then((r) => {
          step(searchStep(flags, r.hits));
          return r;
        });
        const recall = memOk
          ? safe(memoryContext(v, { question, limit: 12 }), { text: "", items: [] as Memory[] }, "memory").then((m) => { step(memoryStep(memoryCounts(m.items))); return m; })
          : Promise.resolve({ text: "", items: [] as Memory[] });
        const [found, mem] = await Promise.all([retrieval, recall]);
        if (mem.items.length) void markMemoriesUsed(v, mem.items.map((m) => m.id)).catch(() => {});

        const items = selectItems(found.items);
        const ctx = numberContext(items);
        for (const s of itemSteps(items, flags)) step(s);
        const off = offWords(flags);
        step(offStep(off));

        // Sensitivity: raised (never lowered) by what this answer draws on.
        const sensitive = ctx.sensitive || turn.sensitiveSoFar;
        if (ctx.sensitive && !turn.sensitiveSoFar) await addState(turn.conversationId, { type: "sensitive" });
        const level = await raiseConversationSensitivity(turn.conversationId, turn.level, ctx.level);
        if (level !== turn.level) send("sensitivity", { level, badge: sensitivityBadge(level) });

        const route = chooseRoute(question, { sensitive });
        if (turn.isNew) titlePromise = writeTitle(v, question, sensitive);
        send("sources", { sources: ctx.citations, route });

        const amb = ambiguousNames(question, found.people);
        const hints = amb.map((a) => `"${a.name}" matches ${a.options.length} people the family knows: ${a.options.map((o) => o.label).join(", ")}. If it matters for the answer and the conversation doesn't say which, ask.`);
        const messages = buildMessages({
          viewerName: v.name, today: longDay(now, tz), timeZone: tz, context: ctx.text, history: turn.history, question,
          tone: (settings.tone as Tone) ?? "warm", memory: mem.text, off, hints, summary: turn.summary, canRemember: memOk && canWrite,
        });
        const filter = new ProposalStreamFilter();
        let raw = "";
        let meta: Omit<mux.MuxResult, "text"> = { model: null, route: null, requestId: null };
        let degraded: DoneEvent["degraded"] = null;
        let stopped = false;
        try {
          const gen = mux.stream({
            route, messages, maxTokens: 1500, temperature: 0.3, signal: both,
            meta: { userId: v.id, agent: "my-graph:assistant", traceId: turn.conversationId, sensitive, graphId: v.graphId },
          });
          for (;;) {
            const r = await gen.next();
            if (r.done) { meta = r.value; break; }
            raw += r.value;
            const out = filter.push(r.value);
            if (out) send("delta", { text: out });
          }
          const tail = filter.flush();
          if (tail) send("delta", { text: tail });
        } catch (e) {
          if (both.aborted) {
            stopped = true;
          } else if (!raw.trim()) {
            degraded = reasonOf(e);
            if (degraded === "error") console.error("[assistant] mux stream failed:", e);
            raw = degradedAnswer(degraded, ctx, items);
            send("delta", { text: raw });
          } else {
            console.error("[assistant] mux stream broke off:", e);
            const note = "\n\n_(The answer was cut off because the model stopped responding.)_";
            raw = parseProposals(parseClarify(raw).text).text + note;
            send("delta", { text: note });
          }
          if (e instanceof mux.MuxError) meta = { model: null, route: null, requestId: e.requestId };
        }
        if (stopped) {
          raw = `${parseProposals(parseClarify(raw).text).text}\n\n_(Stopped.)_`.trim();
        }

        // A clarifying question replaces proposals; when no model could ask, ask about an ambiguous name ourselves.
        const cl = parseClarify(raw);
        let clarify = stopped ? null : cl.clarify;
        if (!clarify && degraded && amb.length) clarify = clarifyFromAmbiguity(amb);
        const content = dropUnknownCitations(clarify ? parseProposals(cl.text).text : cl.text, ctx.citations.length);
        const parsed = parseProposals(content);
        const citations = extractCitations(parsed.text, ctx.citations);
        const thoughtMs = Date.now() - t0;
        const saved = await addMessage(turn.conversationId, {
          role: "assistant", content, citations, model: meta.model, route: meta.route ?? (degraded ? null : route), requestId: meta.requestId,
          steps, thoughtMs, clarify,
        });
        await touchConversation(turn.conversationId);

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
          degraded, title, proposals, clarify, steps, thoughtMs, stopped, text: parsed.text,
        };
        send("done", done);
      } catch (e) {
        console.error("[assistant] turn failed:", e);
        send("error", { message: "Something went wrong on our side while answering. Your question was saved; please try again." });
      } finally {
        if (stops.get(key) === stopper) stops.delete(key);
        close();
      }
    },
  });
}

/** A wiki title reduced to what it is about: "EAM Platform Project notes" and "EAM platform" both become "eam platform". */
export function wikiTitleKey(title: string): string {
  const stop = new Set(["project", "projects", "page", "notes", "note", "wiki", "the", "a", "an", "about", "on", "om", "noter", "side", "projektet", "projekt"]);
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !stop.has(w)).join(" ");
}
