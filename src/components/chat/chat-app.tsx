"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ArrowUp, ChevronDown, Lock, MessageSquare, Plus, Square, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type { Citation } from "@/db/schema";
import { Button, EmptyState } from "@/components/ui";
import type { ConversationSummary, ConversationView, MessageView } from "@/lib/assistant/store";
import type { ProposalView } from "@/lib/assistant/proposals";
import { readSse } from "@/lib/mux/sse";
import { CitationRef } from "./citation";
import { Markdown } from "./markdown";
import { MuxBanner, type MuxStatus } from "./mux-banner";
import { ProposalCard } from "./proposal-card";

const STARTERS = [
  "What's coming up for Emma this week?",
  "When was Noah's last vaccination?",
  "What do we need to prepare for school this week?",
  "Which reminders are open right now?",
];

type UiMessage = MessageView & { streaming?: boolean; live?: Citation[] };

const ROUTE_LABEL: Record<string, string> = {
  fast: "Quick answer", smart: "Careful answer", agent: "Answered on a local model", auto: "Answer",
};

export function ChatApp({ conversations: initialList, conversation, mux, canFix }: {
  conversations: ConversationSummary[];
  conversation: ConversationView | null;
  mux: MuxStatus;
  canFix: boolean;
}) {
  const [list, setList] = useState(initialList);
  const [conversationId, setConversationId] = useState<string | null>(conversation?.id ?? null);
  const [title, setTitle] = useState(conversation?.title ?? "New conversation");
  const [messages, setMessages] = useState<UiMessage[]>(conversation?.messages ?? []);
  const [sensitive, setSensitive] = useState(conversation?.sensitive ?? false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const activeIdRef = useRef<string | null>(conversation?.id ?? null);

  // Follow the answer while it streams, unless the reader scrolled up.
  useEffect(() => {
    const onScroll = () => {
      stickRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Grow the composer with its content.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = useCallback((fn: (m: UiMessage) => UiMessage) => {
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));
  }, []);

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || streaming) return;
    setError(null);
    setInput("");
    stickRef.current = true;
    const now = new Date().toISOString();
    setMessages((ms) => [
      ...ms,
      { id: `local-${Date.now()}`, role: "user", content: question, citations: [], proposals: [], model: null, route: null, createdAt: now },
      { id: "pending", role: "assistant", content: "", citations: [], proposals: [], model: null, route: null, createdAt: now, streaming: true, live: [] },
    ]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let gotDone = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, question }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? "You've been signed out. Sign in again to keep asking." : typeof body.error === "string" ? body.error : "The assistant couldn't answer. Please try again.");
      }
      for await (const ev of readSse(res.body)) {
        let data: Record<string, unknown>;
        try { data = JSON.parse(ev.data); } catch { continue; }
        if (ev.event === "start") {
          const id = String(data.conversationId);
          activeIdRef.current = id;
          setConversationId(id);
          if (data.isNew) {
            const t = String(data.title ?? "New conversation");
            setTitle(t);
            setList((l) => [{ id, title: t, createdAt: now, updatedAt: now }, ...l.filter((c) => c.id !== id)]);
            window.history.replaceState(null, "", `/chat/${id}`);
          }
          if (data.route === "agent") setSensitive(true);
          patchLast((m) => ({ ...m, live: (data.sources as Citation[]) ?? [] }));
        } else if (ev.event === "delta") {
          const t = String(data.text ?? "");
          patchLast((m) => ({ ...m, content: m.content + t }));
        } else if (ev.event === "done") {
          gotDone = true;
          patchLast((m) => ({
            ...m,
            id: String(data.messageId),
            streaming: false,
            live: undefined,
            citations: (data.citations as Citation[]) ?? [],
            proposals: (data.proposals as ProposalView[]) ?? [],
            model: (data.model as string) ?? null,
            route: (data.route as string) ?? null,
          }));
          if (typeof data.title === "string" && data.title) {
            const t = data.title;
            setTitle(t);
            setList((l) => l.map((c) => (c.id === activeIdRef.current ? { ...c, title: t } : c)));
          }
        } else if (ev.event === "error") {
          setError(String(data.message ?? "Something went wrong."));
        }
      }
      if (!gotDone) patchLast((m) => ({ ...m, streaming: false, live: undefined }));
    } catch (e) {
      if (ac.signal.aborted) {
        patchLast((m) => ({ ...m, streaming: false, content: `${m.content}${m.content ? "\n\n" : ""}_(Stopped.)_` }));
      } else {
        setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "We couldn't reach My Graph. Check your connection and try again.");
        // Drop the empty answer bubble; keep the question so it can be retried.
        setMessages((ms) => (ms.length && ms[ms.length - 1].id === "pending" && !ms[ms.length - 1].content ? ms.slice(0, -2) : ms.map((m) => (m.streaming ? { ...m, streaming: false } : m))));
        setInput((cur) => cur || question);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      setList((l) => {
        // Move the active conversation to the top.
        const id = activeIdRef.current;
        const hit = l.find((c) => c.id === id);
        return hit ? [{ ...hit, updatedAt: new Date().toISOString() }, ...l.filter((c) => c.id !== id)] : l;
      });
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  async function remove() {
    if (!conversationId || streaming) return;
    if (!window.confirm(`Delete "${title}"? The messages are removed. Facts, reminders and pages you approved stay.`)) return;
    const res = await fetch(`/api/chat/${conversationId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : "We couldn't delete the conversation.");
      return;
    }
    window.location.assign("/chat");
  }

  /** Start over without a page load (the URL may have been set by replaceState, which the router doesn't track). */
  function startNew(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    abortRef.current?.abort();
    activeIdRef.current = null;
    setConversationId(null);
    setTitle("New conversation");
    setMessages([]);
    setSensitive(false);
    setError(null);
    setListOpen(false);
    window.history.pushState(null, "", "/chat");
    inputRef.current?.focus();
  }

  function decided(messageId: string, p: ProposalView) {
    setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, proposals: m.proposals.map((x) => (x.n === p.n ? p : x)) } : m)));
  }

  const empty = messages.length === 0;

  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-[240px_minmax(0,1fr)]">
      {/* Conversation list */}
      <aside aria-label="Conversations" className="md:sticky md:top-6 md:self-start">
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" className="md:hidden" aria-expanded={listOpen} aria-controls="chat-list" onClick={() => setListOpen((o) => !o)}>
            <MessageSquare aria-hidden className="h-4 w-4" /> Conversations
            <ChevronDown aria-hidden className={clsx("h-4 w-4 transition", listOpen && "rotate-180")} />
          </Button>
          <Link href="/chat" onClick={startNew} className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90 md:ml-0 md:w-full md:justify-center">
            <Plus aria-hidden className="h-4 w-4" /> New conversation
          </Link>
        </div>
        <nav id="chat-list" className={clsx("mt-3 max-h-[60vh] overflow-y-auto md:block md:max-h-[calc(100vh-8rem)]", listOpen ? "block" : "hidden")}>
          {list.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">Your conversations will appear here.</p>
          ) : (
            <ul className="space-y-0.5">
              {list.map((c) => {
                const active = c.id === conversationId;
                return (
                  <li key={c.id}>
                    <Link href={`/chat/${c.id}`} aria-current={active ? "page" : undefined}
                      className={clsx("block truncate rounded-md px-3 py-2 text-sm", active ? "bg-accent-tint font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                      {c.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </aside>

      {/* Thread */}
      <section aria-label="Conversation" className="flex min-h-[70vh] min-w-0 flex-col">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{empty ? "Ask your family brain" : title}</h1>
            <p className="mt-1 text-sm text-muted">
              {empty
                ? "Answers come only from what's in your graph, with a source for every claim."
                : sensitive
                  ? <span className="inline-flex items-center gap-1"><Lock aria-hidden className="h-3.5 w-3.5" /> Private topic: this conversation stays on local models.</span>
                  : "Every answer shows where it came from."}
            </p>
          </div>
          {conversationId && !empty && (
            <Button type="button" variant="ghost" onClick={remove} disabled={streaming} aria-label="Delete this conversation">
              <Trash2 aria-hidden className="h-4 w-4" /> <span className="hidden sm:inline">Delete</span>
            </Button>
          )}
        </header>

        <MuxBanner initial={mux} canFix={canFix} />

        <div className="flex-1 space-y-6" aria-live="polite" aria-busy={streaming}>
          {empty && (
            <EmptyState title="Try asking">
              <ul className="mt-3 flex flex-wrap justify-center gap-2">
                {STARTERS.map((q) => (
                  <li key={q}>
                    <button type="button" onClick={() => void send(q)}
                      className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-fg hover:bg-surface-2">
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </EmptyState>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} conversationId={conversationId} onDecided={decided} />
          ))}
          <div ref={bottomRef} />
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-line bg-surface p-3 text-sm text-danger">{error}</p>
        )}

        <form
          className="sticky bottom-0 mt-4 border-t border-line bg-bg pb-4 pt-3"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <label htmlFor="chat-input" className="sr-only">Your question</label>
          <div className="flex items-end gap-2 rounded-lg border border-line bg-surface p-2 focus-within:border-accent">
            <textarea
              id="chat-input"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={4000}
              placeholder="Ask about school, health, plans… (Enter to send, Shift+Enter for a new line)"
              className="max-h-60 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted"
            />
            {streaming ? (
              <Button type="button" variant="secondary" onClick={() => abortRef.current?.abort()} aria-label="Stop the answer">
                <Square aria-hidden className="h-4 w-4" /> <span className="hidden sm:inline">Stop</span>
              </Button>
            ) : (
              <Button type="submit" disabled={!input.trim()} aria-label="Send">
                <ArrowUp aria-hidden className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function Message({ m, conversationId, onDecided }: { m: UiMessage; conversationId: string | null; onDecided: (messageId: string, p: ProposalView) => void }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-accent-tint px-4 py-2 text-sm text-fg">{m.content}</p>
      </div>
    );
  }
  const citations = m.streaming ? m.live ?? [] : m.citations;
  return (
    <article className="text-sm">
      {m.content ? (
        <Markdown text={m.content} citations={citations} />
      ) : (
        <p className="flex items-center gap-2 text-muted" role="status">
          <span className="inline-flex gap-1" aria-hidden>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted [animation-delay:300ms]" />
          </span>
          Looking through your family brain…
        </p>
      )}

      {!m.streaming && m.citations.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted">Sources</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {m.citations.map((c) => <li key={c.n} className="max-w-full"><CitationRef citation={c} compact={false} /></li>)}
          </ul>
        </div>
      )}

      {!m.streaming && conversationId && m.proposals.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {m.proposals.map((p) => (
            <ProposalCard key={p.n} conversationId={conversationId} messageId={m.id} proposal={p} onDecided={(x) => onDecided(m.id, x)} />
          ))}
        </div>
      )}

      {!m.streaming && (m.route || m.model) && (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted">
          {m.route === "agent" && <Lock aria-hidden className="h-3 w-3" />}
          {ROUTE_LABEL[m.route ?? ""] ?? "Answer"}{m.model ? ` · ${m.model}` : ""}
        </p>
      )}
    </article>
  );
}
