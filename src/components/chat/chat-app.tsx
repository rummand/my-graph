"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Lock, PanelLeft, Pencil, SquarePen, Trash2, X } from "lucide-react";
import { format } from "date-fns";
import type { Citation } from "@/db/schema";
import { IconButton } from "@/components/ui";
import type { ConversationSummary, ConversationView } from "@/lib/assistant/store";
import type { ProposalView } from "@/lib/assistant/proposals";
import { readSse } from "@/lib/mux/sse";
import { MuxBanner, type MuxStatus } from "./mux-banner";
import { ConversationList } from "./conversation-list";
import { Composer } from "./composer";
import { ChatEmpty } from "./empty";
import { Answer, Question, type UiMessage } from "./message";
import type { Starter } from "./recency";

const EASE = [0.22, 1, 0.36, 1] as const;

export function ChatApp({ conversations: initialList, conversation, mux, canFix, starters, initialQuestion }: {
  conversations: ConversationSummary[];
  conversation: ConversationView | null;
  mux: MuxStatus;
  canFix: boolean;
  starters: Starter[];
  /** From /chat?q=…: asked once, as a new conversation, then removed from the URL. */
  initialQuestion?: string | null;
}) {
  const [list, setList] = useState(initialList);
  const [conversationId, setConversationId] = useState<string | null>(conversation?.id ?? null);
  const [title, setTitle] = useState(conversation?.title ?? "New conversation");
  const [startedAt, setStartedAt] = useState<string | null>(conversation?.createdAt ?? null);
  const [messages, setMessages] = useState<UiMessage[]>(() => (conversation?.messages ?? []).map((m) => ({ ...m, uid: m.id })));
  const [sensitive, setSensitive] = useState(conversation?.sensitive ?? false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const activeIdRef = useRef<string | null>(conversation?.id ?? null);

  // Follow the answer while it streams, unless the reader scrolled up to read.
  useEffect(() => {
    const onScroll = () => {
      stickRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (!stickRef.current || !messages.length) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
    // Sources and suggestions open with a short height animation; follow them to the end.
    const t = window.setTimeout(() => { if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, 260);
    return () => window.clearTimeout(t);
  }, [messages]);
  // Open an existing conversation at its latest answer.
  useLayoutEffect(() => {
    if (conversation?.messages.length) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [conversation]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Close the drawer with Escape.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const patchLast = useCallback((fn: (m: UiMessage) => UiMessage) => {
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));
  }, []);

  async function send(text?: string, force = false) {
    const question = (text ?? input).trim();
    if (!question || (streaming && !force)) return;
    setError(null);
    if (!text) setInput("");
    stickRef.current = true;
    const now = new Date().toISOString();
    const stamp = Date.now();
    setMessages((ms) => [
      ...ms.map((m) => (m.fresh ? { ...m, fresh: false } : m)),
      { id: `local-${stamp}`, uid: `q-${stamp}`, fresh: true, role: "user", content: question, citations: [], proposals: [], model: null, route: null, createdAt: now },
      { id: "pending", uid: `a-${stamp}`, fresh: true, role: "assistant", content: "", citations: [], proposals: [], model: null, route: null, createdAt: now, streaming: true, live: [] },
    ]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let gotDone = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: activeIdRef.current, question }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? "You've been signed out. Sign in again to keep asking." : typeof body.error === "string" ? body.error : "The assistant couldn't answer. Try again in a moment.");
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
            setStartedAt(now);
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
          setError(String(data.message ?? "Something went wrong while answering."));
        }
      }
      if (!gotDone) patchLast((m) => ({ ...m, streaming: false, live: undefined }));
    } catch (e) {
      if (ac.signal.aborted) {
        patchLast((m) => ({ ...m, streaming: false, content: `${m.content}${m.content ? "\n\n" : ""}_(Stopped.)_` }));
      } else {
        setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "We couldn't reach My Graph. Check your connection and try again.");
        // Drop the empty answer; keep the question in the box so it can be sent again.
        setMessages((ms) => (ms.length && ms[ms.length - 1].id === "pending" && !ms[ms.length - 1].content ? ms.slice(0, -2) : ms.map((m) => (m.streaming ? { ...m, streaming: false } : m))));
        setInput((cur) => cur || question);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      setList((l) => {
        const id = activeIdRef.current;
        const hit = l.find((c) => c.id === id);
        return hit ? [{ ...hit, updatedAt: new Date().toISOString() }, ...l.filter((c) => c.id !== id)] : l;
      });
      inputRef.current?.focus({ preventScroll: true });
    }
  }

  // "Ask anything" in the shell lands here with ?q=…: start a new conversation with it once, then tidy the URL.
  // Deferred a tick so React's dev double-mount can't start (and abort) a second request.
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialQuestion || conversation || askedRef.current === initialQuestion) return;
    const t = window.setTimeout(() => {
      if (askedRef.current === initialQuestion) return;
      askedRef.current = initialQuestion;
      if (activeIdRef.current || abortRef.current) reset("/chat", "replace");
      else window.history.replaceState(null, "", "/chat");
      void send(initialQuestion, true);
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion, conversation]);

  async function rename(id: string, next: string): Promise<boolean> {
    const res = await fetch(`/api/chat/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: next }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : "We couldn't rename that conversation.");
      return false;
    }
    setList((l) => l.map((c) => (c.id === id ? { ...c, title: next } : c)));
    if (id === activeIdRef.current) setTitle(next);
    return true;
  }

  async function remove(id: string): Promise<boolean> {
    if (id === activeIdRef.current && streaming) return false;
    const res = await fetch(`/api/chat/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : "We couldn't delete that conversation.");
      return false;
    }
    setList((l) => l.filter((c) => c.id !== id));
    if (id === activeIdRef.current) reset("/chat", "replace");
    return true;
  }

  function reset(url: string, how: "push" | "replace") {
    abortRef.current?.abort();
    activeIdRef.current = null;
    setConversationId(null);
    setTitle("New conversation");
    setStartedAt(null);
    setMessages([]);
    setSensitive(false);
    setError(null);
    setInput("");
    setDrawer(false);
    if (how === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
    window.scrollTo({ top: 0 });
    inputRef.current?.focus({ preventScroll: true });
  }

  /** Start over without a page load (the URL may have been set by replaceState, which the router doesn't track). */
  function startNew(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    reset("/chat", "push");
  }

  function decided(messageId: string, p: ProposalView) {
    setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, proposals: m.proposals.map((x) => (x.n === p.n ? p : x)) } : m)));
  }

  const empty = messages.length === 0;
  const listProps = { list, activeId: conversationId, onNew: startNew, onRename: rename, onDelete: remove, busy: streaming };

  return (
    <div className="-mb-28 lg:-mb-16 lg:grid lg:grid-cols-[216px_minmax(0,1fr)] lg:gap-10">
      {/* Conversations: a quiet column on desktop, a drawer on phones. */}
      <aside className="hidden lg:sticky lg:top-0 lg:-mt-9 lg:block lg:h-dvh lg:pb-2 lg:pt-9">
        <ConversationList {...listProps} />
      </aside>
      <AnimatePresence>
        {drawer && (
          <>
            <motion.div key="scrim" className="fixed inset-0 z-50 bg-fg/30 lg:hidden" onClick={() => setDrawer(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            <motion.div key="drawer" role="dialog" aria-modal="true" aria-label="Conversations"
              className="fixed inset-y-0 left-0 z-50 flex w-[86vw] max-w-[320px] flex-col bg-bg px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 shadow-float lg:hidden"
              initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}>
              <div className="mb-2 flex items-center justify-between pl-2.5">
                <p className="font-semibold">Conversations</p>
                <IconButton label="Close conversations" onClick={() => setDrawer(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="min-h-0 flex-1"><ConversationList {...listProps} onNavigate={() => setDrawer(false)} /></div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* The thread: one reading column, the composer pinned under it. */}
      <section aria-label="Conversation" className="flex min-h-[calc(100dvh-4.5rem)] min-w-0 flex-col pb-[calc(56px+env(safe-area-inset-bottom))] lg:min-h-[calc(100dvh-2.25rem)] lg:pb-0">
        <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col">
          <ThreadBar
            title={empty ? null : title}
            startedAt={startedAt}
            sensitive={sensitive}
            canEdit={!!conversationId && !empty}
            busy={streaming}
            onOpenList={() => setDrawer(true)}
            onNew={startNew}
            onRename={(t) => (conversationId ? rename(conversationId, t) : Promise.resolve(false))}
            onDelete={() => (conversationId ? remove(conversationId) : Promise.resolve(false))}
          />

          <MuxBanner initial={mux} canFix={canFix} />

          <div className="flex-1 pb-10" aria-live="polite" aria-busy={streaming}>
            {empty ? (
              <ChatEmpty starters={starters} onPick={(q) => void send(q)} />
            ) : (
              messages.map((m, i) => m.role === "user"
                ? <Question key={m.uid} m={m} first={i === 0} />
                : <Answer key={m.uid} m={m} conversationId={conversationId} onDecided={decided} />)
            )}
            <div ref={bottomRef} />
          </div>

          <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-20 -mx-2 bg-bg px-2 pb-3 pt-2 lg:bottom-0 lg:pb-6">
            <AnimatePresence>
              {error && (
                <motion.div key="err" role="alert" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
                  className="mb-2 flex items-start gap-3 rounded-lg bg-danger-tint px-4 py-3 text-sm text-danger">
                  <p className="min-w-0 flex-1">{error}</p>
                  <button type="button" onClick={() => setError(null)} aria-label="Dismiss this message" className="-m-1 rounded p-1 hover:bg-surface/50"><X aria-hidden className="size-4" /></button>
                </motion.div>
              )}
            </AnimatePresence>
            <Composer value={input} onChange={setInput} onSend={() => void send()} onStop={() => abortRef.current?.abort()}
              streaming={streaming} sensitive={sensitive} empty={empty} inputRef={inputRef} />
          </div>
        </div>
      </section>
    </div>
  );
}

function ThreadBar({ title, startedAt, sensitive, canEdit, busy, onOpenList, onNew, onRename, onDelete }: {
  title: string | null; startedAt: string | null; sensitive: boolean; canEdit: boolean; busy: boolean;
  onOpenList: () => void; onNew: (e: MouseEvent) => void;
  onRename: (t: string) => Promise<boolean>; onDelete: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(title ?? "");
  const [saving, setSaving] = useState(false);
  const started = startedAt ? new Date(startedAt) : null;

  useEffect(() => { setMode("view"); setDraft(title ?? ""); }, [title]);

  async function save() {
    const t = draft.trim();
    if (!t || t === title) { setMode("view"); return; }
    setSaving(true);
    if (await onRename(t)) setMode("view");
    setSaving(false);
  }

  return (
    <div className="mb-8 flex min-h-9 items-center gap-2 lg:mb-10">
      <IconButton label="Show conversations" className="-ml-1.5 lg:hidden" onClick={onOpenList}><PanelLeft className="size-[18px]" /></IconButton>
      <div className="min-w-0 flex-1">
        {mode === "rename" ? (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label htmlFor="thread-title" className="sr-only">Conversation name</label>
            <input id="thread-title" autoFocus value={draft} maxLength={120} disabled={saving}
              onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => { if (e.key === "Escape") { setMode("view"); setDraft(title ?? ""); } }}
              className="h-8 min-w-0 flex-1 rounded-md bg-surface px-2 text-sm font-medium outline-none ring-1 ring-inset ring-accent" />
            <button type="submit" disabled={saving} className="h-8 rounded-md bg-fg px-3 text-sm font-medium text-bg active:scale-[0.97]">{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => { setMode("view"); setDraft(title ?? ""); }} className="h-8 rounded-md px-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">Cancel</button>
          </form>
        ) : mode === "delete" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" role="group" aria-label="Delete this conversation">
            <span className="font-medium text-danger">Delete this conversation?</span>
            <span className="hidden text-muted sm:inline">Things you approved from it stay.</span>
            <span className="flex gap-1.5">
              <button type="button" autoFocus disabled={saving} onClick={async () => { setSaving(true); if (!(await onDelete())) { setSaving(false); setMode("view"); } }}
                className="h-8 rounded-md bg-danger px-3 font-medium text-white active:scale-[0.97] disabled:opacity-60">{saving ? "Deleting…" : "Delete"}</button>
              <button type="button" onClick={() => setMode("view")} className="h-8 rounded-md px-2.5 text-muted hover:bg-surface-2 hover:text-fg">Keep it</button>
            </span>
          </div>
        ) : title ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="flex items-center gap-1.5 truncate text-xs text-muted">
              {sensitive && <><Lock aria-hidden className="size-3" /> <span>Private, local models only.</span></>}
              {started && !Number.isNaN(started.getTime()) && <span>Started {format(started, "EEE d MMM")}</span>}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted lg:hidden">New conversation</p>
        )}
      </div>
      {mode === "view" && (
        <div className="flex shrink-0 items-center">
          {canEdit && <IconButton label="Rename this conversation" onClick={() => setMode("rename")}><Pencil className="size-4" /></IconButton>}
          {canEdit && <IconButton label="Delete this conversation" onClick={() => setMode("delete")} disabled={busy}><Trash2 className="size-4" /></IconButton>}
          <Link href="/chat" onClick={onNew} aria-label="New conversation" title="New conversation"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg lg:hidden">
            <SquarePen className="size-4" aria-hidden />
          </Link>
        </div>
      )}
    </div>
  );
}
