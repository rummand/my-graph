/**
 * One chat turn (server-only): retrieve → number the context → stream the answer from mux → persist with citations.
 * The HTTP stream is SSE with these events:
 *   start  { conversationId, userMessageId, title, route, isNew, sources }  — sources: every numbered item
 *   delta  { text }                                      — visible answer text (proposals block held back)
 *   done   { messageId, citations, proposals, model, route, requestId, degraded, title }
 *   error  { message }                                   — only for failures before anything was saved
 */
import type { Viewer } from "@/lib/auth";
import * as mux from "@/lib/mux";
import { formatSse } from "@/lib/mux/sse";
import { extractCitations, numberContext, selectItems } from "./context";
import { degradedAnswer, type DegradedReason } from "./fallback";
export { degradedAnswer, type DegradedReason };
import { longDay, timeZone } from "./dates";
import { buildMessages, cleanTitle, fallbackTitle, titleMessages, type HistoryTurn } from "./prompt";
import { parseProposals, ProposalStreamFilter, type ProposalView } from "./proposals";
import { retrieve } from "./retrieve";
import { chooseRoute } from "./route";
import { foldState } from "./state";
import { addMessage, addState, conversationRows, createConversation, ownConversation, renameConversation, touchConversation } from "./store";
import type { Citation } from "@/db/schema";

export class ChatInputError extends Error {
  constructor(public status: 400 | 404, message: string) { super(message); }
}

export type DoneEvent = {
  messageId: string; citations: Citation[]; proposals: ProposalView[]; model: string | null; route: string | null;
  requestId: string | null; degraded: null | DegradedReason; title: string | null;
};

function reasonOf(e: unknown): DegradedReason {
  if (e instanceof mux.MuxAuthError) return e.type === "not_configured" ? "not_configured" : "rejected";
  if (e instanceof mux.MuxUnavailableError) return "unreachable";
  return "error";
}

async function writeTitle(v: Viewer, question: string, sensitive: boolean): Promise<string> {
  try {
    const r = await Promise.race([
      mux.complete({ route: "fast", messages: titleMessages(question), maxTokens: 24, temperature: 0.2, meta: { userId: v.id, agent: "my-graph:chat-title", sensitive } }),
      new Promise<null>((res) => setTimeout(() => res(null), 8000)),
    ]);
    return r ? cleanTitle(r.text, question) : fallbackTitle(question);
  } catch {
    return fallbackTitle(question);
  }
}

/** Validate and set up a turn before any streaming starts (so bad ids answer 404, not a broken stream). */
export async function prepareTurn(v: Viewer, input: { conversationId?: string | null; question: string }) {
  let conversationId = input.conversationId ?? null;
  let isNew = false;
  let history: HistoryTurn[] = [];
  let sensitiveSoFar = false;
  let title = fallbackTitle(input.question);
  if (conversationId) {
    const c = await ownConversation(v, conversationId);
    if (!c) throw new ChatInputError(404, "That conversation doesn't exist or isn't yours.");
    title = c.title;
    const rows = await conversationRows(c.id);
    sensitiveSoFar = foldState(rows.filter((r) => r.role === "system").map((r) => r.content)).sensitive;
    history = rows.filter((r) => r.role !== "system").map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  } else {
    conversationId = (await createConversation(v, title)).id;
    isNew = true;
  }
  const user = await addMessage(conversationId, { role: "user", content: input.question });
  await touchConversation(conversationId);
  return { conversationId, isNew, history, sensitiveSoFar, title, userMessageId: user.id };
}

export function runTurn(v: Viewer, turn: Awaited<ReturnType<typeof prepareTurn>>, question: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(formatSse(event, data))); } catch { closed = true; }
      };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };

      const tz = timeZone();
      const now = new Date();
      let titlePromise: Promise<string> | null = null;
      try {
        const items = selectItems(await retrieve(v, question, { tz, now }));
        const ctx = numberContext(items);
        const sensitive = ctx.sensitive || turn.sensitiveSoFar;
        if (ctx.sensitive && !turn.sensitiveSoFar) await addState(turn.conversationId, { type: "sensitive" });
        const route = chooseRoute(question, { sensitive });
        if (turn.isNew) titlePromise = writeTitle(v, question, sensitive);

        send("start", { conversationId: turn.conversationId, userMessageId: turn.userMessageId, title: turn.title, route, isNew: turn.isNew, sources: ctx.citations });

        const messages = buildMessages({ viewerName: v.name, today: longDay(now, tz), timeZone: tz, context: ctx.text, history: turn.history, question });
        const filter = new ProposalStreamFilter();
        let raw = "";
        let meta: Omit<mux.MuxResult, "text"> = { model: null, route: null, requestId: null };
        let degraded: DoneEvent["degraded"] = null;
        let stopped = false;
        try {
          const gen = mux.stream({
            route, messages, maxTokens: 1500, temperature: 0.3, signal,
            meta: { userId: v.id, agent: "my-graph:assistant", traceId: turn.conversationId, sensitive },
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
          if (signal.aborted) {
            stopped = true;
          } else if (!raw.trim()) {
            degraded = reasonOf(e);
            if (degraded === "error") console.error("[assistant] mux stream failed:", e);
            raw = degradedAnswer(degraded, ctx, items);
            send("delta", { text: raw });
          } else {
            console.error("[assistant] mux stream broke off:", e);
            const note = "\n\n_(The answer was cut off because the model stopped responding.)_";
            raw = parseProposals(raw).text + note;
            send("delta", { text: note });
          }
          if (e instanceof mux.MuxError) meta = { model: null, route: null, requestId: e.requestId };
        }
        if (stopped) {
          raw = `${parseProposals(raw).text}\n\n_(Stopped.)_`.trim();
        }

        const parsed = parseProposals(raw);
        const citations = extractCitations(parsed.text, ctx.citations);
        const saved = await addMessage(turn.conversationId, {
          role: "assistant", content: raw, citations, model: meta.model, route: meta.route ?? (degraded ? null : route), requestId: meta.requestId,
        });
        await touchConversation(turn.conversationId);

        let title: string | null = null;
        if (titlePromise) {
          title = await titlePromise;
          if (title !== turn.title) await renameConversation(turn.conversationId, title);
        }
        const done: DoneEvent = {
          messageId: saved.id, citations, model: meta.model, route: meta.route ?? (degraded ? null : route), requestId: meta.requestId,
          degraded, title,
          proposals: (stopped || degraded ? [] : parsed.proposals).map((p, i) => ({ ...p, n: i + 1, status: "pending" as const, result: null })),
        };
        send("done", done);
      } catch (e) {
        console.error("[assistant] turn failed:", e);
        send("error", { message: "Something went wrong on our side while answering. Your question was saved; please try again." });
      } finally {
        close();
      }
    },
  });
}
