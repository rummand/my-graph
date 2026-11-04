"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type MutableRefObject, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Archive, ChevronRight, Lock, MailOpen, Mail, PanelLeft, Pencil, Pin, PinOff, SquarePen, Trash2, X } from "lucide-react";
import type { PageContext } from "@/lib/assistant/page-context";
import { ASK_EVENT, type AskDetail } from "@/components/assistant/events";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import { GraphKindContext } from "./graph-kind";
import type { AssistantStep, Citation } from "@/db/schema";
import { IconButton } from "@/components/ui";
import type { ConversationSummary, ConversationView } from "@/lib/assistant/store";
import type { ProposalView } from "@/lib/assistant/proposals";
import type { McpApproval } from "@/lib/mcp-client";
import type { Clarify } from "@/lib/assistant/clarify";
import { sensitivityBadge, type Sensitivity } from "@/lib/assistant/sensitivity";
import { readSse } from "@/lib/mux/sse";
import { MuxBanner, type MuxStatus } from "./mux-banner";
import { ConversationList } from "./conversation-list";
import { Composer, type ComposerSend } from "./composer";
import { linkFirstOccurrences } from "@/lib/mentions/markup";
import { ChatEmpty } from "./empty";
import { Answer, Question, type UiMessage } from "./message";
import { ThreadMenu } from "./thread-menu";
import type { Starter } from "./recency";

const EASE = [0.22, 1, 0.36, 1] as const;

type Queued = { id: number; text: string };

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : fallback;
}

/** Tell the server which conversation is the active session (fire and forget: the next question also sets it). */
function setActiveSession(conversationId: string | null) {
  void fetch("/api/chat/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) }).catch(() => {});
}

export function ChatApp({ conversations: initialList, conversation, mux, canFix, starters, graphKind = "other", initialQuestion, startedNew = false,
  variant = "page", pageContext = null, askRef, onBusy, onActive, onOpenSession, panelActions }: {
  conversations: ConversationSummary[];
  conversation: ConversationView | null;
  mux: MuxStatus;
  canFix: boolean;
  starters: Starter[];
  /** The current graph's kind: family-only wording shows only in family graphs. */
  graphKind?: string;
  /** From /chat?q=…: asked once, as a new conversation, then removed from the URL. */
  initialQuestion?: string | null;
  /** /chat?new=1: a new conversation was asked for; it becomes the active session. */
  startedNew?: boolean;
  /** "page": /chat, full size. "panel": the Ask panel beside every page (scrolls itself, no URL changes). */
  variant?: "page" | "panel";
  /** Panel: what is open on the page (sent with each question while its chip is kept). */
  pageContext?: PageContext | null;
  /** Lets the shell's "Ask anything" put a question to this session. */
  askRef?: MutableRefObject<((q: string) => void) | null>;
  onBusy?: (busy: boolean) => void;
  /** The active conversation changed (a new one started, or one was cleared). */
  onActive?: (id: string | null) => void;
  /** Panel: reopen a saved session in place. */
  onOpenSession?: (id: string) => void;
  /** Panel: buttons for the panel header (open full size, close). */
  panelActions?: ReactNode;
}) {
  const panel = variant === "panel";
  const t = useT();
  const [list, setList] = useState(initialList);
  const [conversationId, setConversationId] = useState<string | null>(conversation?.id ?? null);
  const [title, setTitle] = useState(conversation?.title ?? t("chat.thread.newConversation"));
  const [startedAt, setStartedAt] = useState<string | null>(conversation?.createdAt ?? null);
  const [messages, setMessages] = useState<UiMessage[]>(() => (conversation?.messages ?? []).map((m) => ({ ...m, uid: m.id })));
  const [sensitive, setSensitive] = useState(conversation?.sensitive ?? false);
  const [level, setLevel] = useState<Sensitivity>(conversation?.sensitivity ?? "normal");
  const [summary, setSummary] = useState<{ text: string; upTo: string } | null>(
    conversation?.summary && conversation.summaryUpToMessageId ? { text: conversation.summary, upTo: conversation.summaryUpToMessageId } : null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeHref, setNoticeHref] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const activeIdRef = useRef<string | null>(conversation?.id ?? null);
  const queueId = useRef(0);
  const stopTimer = useRef<number | undefined>(undefined);

  const current = list.find((c) => c.id === conversationId) ?? null;

  const scrollRef = useRef<HTMLDivElement>(null);
  /** The page scrolls the window; the panel scrolls its own body. */
  const toBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (panel && el) { el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" }); return; }
    if (!panel) bottomRef.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
  }, [panel]);

  // Follow the answer while it streams, unless the reader scrolled up to read.
  useEffect(() => {
    const el = panel ? scrollRef.current : null;
    const onScroll = () => {
      stickRef.current = el
        ? el.scrollTop + el.clientHeight >= el.scrollHeight - 160
        : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    const target: HTMLElement | Window = el ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [panel]);
  useLayoutEffect(() => {
    if (!stickRef.current || !messages.length) return;
    toBottom(false);
    const t = window.setTimeout(() => { if (stickRef.current) toBottom(true); }, 260);
    return () => window.clearTimeout(t);
  }, [messages, toBottom]);
  useLayoutEffect(() => {
    if (!conversation?.messages.length) return;
    if (panel) toBottom(false); else window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [conversation, panel, toBottom]);

  useEffect(() => { onBusy?.(streaming); }, [streaming, onBusy]);

  // "Ask anything" in the shell asks in this session.
  useEffect(() => {
    if (!askRef) return;
    askRef.current = (q: string) => submit(q);
    return () => { askRef.current = null; };
  });

  // On /chat, "Ask anything" asks here (elsewhere the Ask panel takes it).
  useEffect(() => {
    if (panel) return;
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<AskDetail>).detail;
      d.handled = true;
      if (d.question) submit(d.question); else inputRef.current?.focus();
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  });

  // /chat?new=1 (a new conversation opened in its own tab): that is now the active session.
  useEffect(() => {
    if (!startedNew || panel) return;
    setActiveSession(null);
    window.history.replaceState(null, "", "/chat");
  }, [startedNew, panel]);

  // The page's chip: kept until removed, and back when another page is opened.
  const [pageOff, setPageOff] = useState(false);
  useEffect(() => { setPageOff(false); }, [pageContext?.path]);
  const page = panel && pageContext && !pageOff ? pageContext : null;

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => { setNotice(null); setNoticeHref(null); }, noticeHref ? 9000 : 5000);
    return () => window.clearTimeout(timer);
  }, [notice, noticeHref]);

  const patchLast = useCallback((fn: (m: UiMessage) => UiMessage) => {
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));
  }, []);

  /** Ask now, or — while an answer is being written — queue it to send in order. */
  function submit(text?: string) {
    const question = (text ?? input).trim();
    if (!question) return;
    if (!text) setInput("");
    if (streamingRef.current) {
      setQueue((q) => [...q, { id: ++queueId.current, text: question }]);
      return;
    }
    void ask(question);
  }

  /**
   * Send from the live-highlighting composer: first add what the person kept in the "Will add" strip (a change set,
   * delivered because Send is their decision), then ask the question with mention markup for what was added.
   */
  async function sendFromComposer(p: ComposerSend) {
    setInput("");
    let text = p.text;
    if (p.plan) {
      try {
        const res = await fetch("/api/annotate/commit", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: p.text, conversationId: activeIdRef.current, plan: p.plan }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          const nodes = (body.nodes ?? []) as { label: string; nodeId: string }[];
          text = linkFirstOccurrences(text, nodes);
          if (body.applied) {
            setNotice(addedNotice(p.plan, t));
            setNoticeHref(typeof body.changeSetId === "string" && body.via === "change_set" ? `/changes/${body.changeSetId}` : null);
          }
        } else {
          setNotice(typeof body.error === "string" ? `${body.error} ${t("chat.notice.sentAnyway")}` : t("chat.notice.addFailed"));
        }
      } catch {
        setNotice(t("chat.notice.addFailedNow"));
      }
    }
    submit(text);
  }

  async function ask(question: string) {
    setError(null);
    stickRef.current = true;
    streamingRef.current = true;
    const now = new Date().toISOString();
    const stamp = Date.now();
    const blank = { citations: [], proposals: [], model: null, route: null, createdAt: now, steps: [] as AssistantStep[], thoughtMs: null, clarify: null, feedback: null };
    setMessages((ms) => [
      ...ms.map((m) => (m.fresh ? { ...m, fresh: false } : m)),
      { ...blank, id: `local-${stamp}`, uid: `q-${stamp}`, fresh: true, role: "user", content: question },
      { ...blank, id: "pending", uid: `a-${stamp}`, fresh: true, role: "assistant", content: "", streaming: true, live: [] },
    ]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let gotDone = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: activeIdRef.current, question, ...(page ? { page } : {}) }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(res.status === 401 ? t("chat.errors.signedOut") : await errorOf(res, t("chat.errors.couldntAnswer")));
      }
      for await (const ev of readSse(res.body)) {
        let data: Record<string, unknown>;
        try { data = JSON.parse(ev.data); } catch { continue; }
        if (ev.event === "start") {
          const id = String(data.conversationId);
          activeIdRef.current = id;
          setConversationId(id);
          if (data.isNew) {
            const nt = String(data.title ?? t("chat.thread.newConversation"));
            setTitle(nt);
            setStartedAt(now);
            setList((l) => [{ id, title: nt, createdAt: now, updatedAt: now, pinned: false, unread: false, sensitivity: "normal" }, ...l.filter((c) => c.id !== id)]);
            if (!panel) window.history.replaceState(null, "", `/chat/${id}`);
            onActive?.(id);
          }
        } else if (ev.event === "step") {
          const step = data.step as AssistantStep;
          patchLast((m) => ({ ...m, steps: [...m.steps, step] }));
        } else if (ev.event === "sources") {
          if (data.route === "agent") setSensitive(true);
          patchLast((m) => ({ ...m, live: (data.sources as Citation[]) ?? [] }));
        } else if (ev.event === "sensitivity") {
          const lv = data.level as Sensitivity;
          setLevel(lv);
          setList((l) => l.map((c) => (c.id === activeIdRef.current ? { ...c, sensitivity: lv } : c)));
        } else if (ev.event === "delta") {
          const delta = String(data.text ?? "");
          patchLast((m) => ({ ...m, content: m.content + delta }));
        } else if (ev.event === "done") {
          gotDone = true;
          patchLast((m) => ({
            ...m,
            id: String(data.messageId),
            streaming: false,
            live: undefined,
            citations: (data.citations as Citation[]) ?? [],
            proposals: (data.proposals as ProposalView[]) ?? [],
            clarify: (data.clarify as Clarify | null) ?? null,
            steps: (data.steps as AssistantStep[]) ?? m.steps,
            thoughtMs: typeof data.thoughtMs === "number" ? data.thoughtMs : null,
            model: (data.model as string) ?? null,
            route: (data.route as string) ?? null,
            content: typeof data.text === "string" ? data.text : m.content,
            mcpApprovals: Array.isArray(data.mcpApprovals) ? (data.mcpApprovals as McpApproval[]) : [],
          }));
          if (typeof data.title === "string" && data.title) {
            const nt = data.title;
            setTitle(nt);
            setList((l) => l.map((c) => (c.id === activeIdRef.current ? { ...c, title: nt } : c)));
          }
        } else if (ev.event === "error") {
          setError(String(data.message ?? t("chat.errors.whileAnswering")));
        }
      }
      if (!gotDone) patchLast((m) => ({ ...m, streaming: false, live: undefined }));
    } catch (e) {
      if (ac.signal.aborted) {
        patchLast((m) => ({ ...m, streaming: false, live: undefined, content: `${m.content}${m.content ? "\n\n" : ""}_${t("chat.stopped")}_` }));
      } else {
        setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : t("chat.errors.offline"));
        setMessages((ms) => (ms.length && ms[ms.length - 1].id === "pending" && !ms[ms.length - 1].content ? ms.slice(0, -2) : ms.map((m) => (m.streaming ? { ...m, streaming: false } : m))));
        setInput((cur) => cur || question);
        setQueue([]);
      }
    } finally {
      window.clearTimeout(stopTimer.current);
      streamingRef.current = false;
      setStreaming(false);
      setStopping(false);
      abortRef.current = null;
      setList((l) => {
        const id = activeIdRef.current;
        const hit = l.find((c) => c.id === id);
        return hit ? [{ ...hit, updatedAt: new Date().toISOString() }, ...l.filter((c) => c.id !== id)] : l;
      });
      inputRef.current?.focus({ preventScroll: true });
    }
  }

  // Follow-ups typed while it was answering go out one by one, in order.
  useEffect(() => {
    if (streaming || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void ask(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, queue]);

  /** Stop cleanly: the server ends the model stream and keeps what was written (with its id, sources, feedback). */
  async function stop() {
    setQueue([]);
    const id = activeIdRef.current;
    const ac = abortRef.current;
    if (!ac) return;
    setStopping(true);
    if (!id) { ac.abort(); return; }
    // If the server can't be told, or doesn't finish quickly, drop the connection; the server saves either way.
    stopTimer.current = window.setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(`/api/chat/${id}/stop`, { method: "POST" });
      if (!res.ok) ac.abort();
    } catch {
      ac.abort();
    }
  }

  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialQuestion || conversation || askedRef.current === initialQuestion) return;
    const timer = window.setTimeout(() => {
      if (askedRef.current === initialQuestion) return;
      askedRef.current = initialQuestion;
      if (activeIdRef.current || abortRef.current) reset("/chat", "replace");
      else window.history.replaceState(null, "", "/chat");
      void ask(initialQuestion);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion, conversation]);

  async function patch(id: string, body: { title?: string; pinned?: boolean; unread?: boolean }, fallback: string): Promise<boolean> {
    const res = await fetch(`/api/chat/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { setError(await errorOf(res, fallback)); return false; }
    setList((l) => l.map((c) => (c.id === id ? { ...c, ...body } : c)));
    if (body.title && id === activeIdRef.current) setTitle(body.title);
    return true;
  }

  const rename = (id: string, next: string) => patch(id, { title: next }, t("chat.errors.rename"));
  const pin = (id: string, pinned: boolean) => patch(id, { pinned }, pinned ? t("chat.errors.pin") : t("chat.errors.unpin"));

  async function markUnread(id: string, unread: boolean) {
    if (await patch(id, { unread }, t("chat.errors.change"))) setNotice(unread ? t("chat.notice.markedUnread") : t("chat.notice.markedRead"));
  }

  async function remove(id: string): Promise<boolean> {
    if (id === activeIdRef.current && streamingRef.current) return false;
    const res = await fetch(`/api/chat/${id}`, { method: "DELETE" });
    if (!res.ok) { setError(await errorOf(res, t("chat.errors.delete"))); return false; }
    setList((l) => l.filter((c) => c.id !== id));
    if (id === activeIdRef.current) reset("/chat", "replace");
    return true;
  }

  const [compacting, setCompacting] = useState(false);
  async function compact() {
    const id = activeIdRef.current;
    if (!id || streamingRef.current) return;
    setCompacting(true); setError(null);
    try {
      const res = await fetch(`/api/chat/${id}/compact`, { method: "POST" });
      if (!res.ok) { setError(await errorOf(res, t("chat.errors.compact"))); return; }
      const body = await res.json();
      setSummary({ text: String(body.summary ?? ""), upTo: String(body.upToMessageId) });
      setNotice(t(body.degraded ? "chat.notice.compactedDegraded" : "chat.notice.compacted", { count: Number(body.compacted) || 0 }));
    } catch {
      setError(t("chat.errors.offline"));
    } finally {
      setCompacting(false);
    }
  }

  async function feedback(messageId: string, value: 1 | -1 | null) {
    const id = activeIdRef.current;
    if (!id) return;
    const prev = messages.find((m) => m.id === messageId)?.feedback ?? null;
    setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, feedback: value } : m)));
    try {
      const res = await fetch(`/api/chat/${id}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, value }) });
      if (!res.ok) throw new Error(await errorOf(res, t("chat.errors.save")));
      if (value === -1) setNotice(t("chat.notice.notHelpful"));
    } catch (e) {
      setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, feedback: prev } : m)));
      setError(e instanceof Error ? e.message : t("chat.errors.save"));
    }
  }

  function reset(url: string, how: "push" | "replace") {
    abortRef.current?.abort();
    activeIdRef.current = null;
    setConversationId(null);
    setTitle(t("chat.thread.newConversation"));
    setStartedAt(null);
    setMessages([]);
    setSensitive(false);
    setLevel("normal");
    setSummary(null);
    setQueue([]);
    setError(null);
    setNotice(null);
    setNoticeHref(null);
    setInput("");
    setDrawer(false);
    setActiveSession(null);
    onActive?.(null);
    if (panel) {
      scrollRef.current?.scrollTo({ top: 0 });
    } else {
      if (how === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
      window.scrollTo({ top: 0 });
    }
    inputRef.current?.focus({ preventScroll: true });
  }

  function startNew(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    reset("/chat", "push");
  }

  function decided(messageId: string, p: ProposalView) {
    setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, proposals: m.proposals.map((x) => (x.n === p.n ? p : x)) } : m)));
  }

  const empty = messages.length === 0;
  const lastAnswerId = [...messages].reverse().find((m) => m.role === "assistant")?.uid;
  const listProps = { list, activeId: conversationId, onNew: startNew, onRename: rename, onDelete: remove, onPin: pin, busy: streaming };

  const threadBar = (
    <ThreadBar
      title={empty ? null : title}
      startedAt={startedAt}
      sensitive={sensitive}
      level={level}
      canEdit={!!conversationId && !empty}
      busy={streaming}
      pinned={!!current?.pinned}
      unread={!!current?.unread}
      compacting={compacting}
      canCompact={messages.filter((m) => !m.id.startsWith("local-")).length > 5}
      onOpenList={() => setDrawer(true)}
      onNew={startNew}
      onRename={(t) => (conversationId ? rename(conversationId, t) : Promise.resolve(false))}
      onDelete={() => (conversationId ? remove(conversationId) : Promise.resolve(false))}
      onPin={() => conversationId && void pin(conversationId, !current?.pinned)}
      onUnread={() => conversationId && void markUnread(conversationId, !current?.unread)}
      onCompact={() => void compact()}
      panel={panel}
      extra={panelActions}
    />
  );

  const thread = (
    <div className={panel ? "pb-6" : "flex-1 pb-10"} aria-live="polite" aria-busy={streaming}>
      {empty ? (
        <ChatEmpty starters={starters} onPick={(q) => submit(q)} />
      ) : (
        messages.map((m, i) => (
          <div key={m.uid}>
            {m.role === "user"
              ? <Question m={m} first={i === 0 && !panel} />
              : <Answer m={m} conversationId={conversationId} onDecided={decided} onFeedback={feedback}
                  canClarify={!streaming && m.uid === lastAnswerId} onClarify={(t) => submit(t)} />}
            {summary && m.id === summary.upTo && <SummaryDivider text={summary.text} />}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );

  const chip = page?.title ? (
    <div className="flex items-center gap-1.5 px-3 pt-2.5">
      <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-accent-tint py-0.5 pl-2.5 pr-1 text-xs text-accent">
        <span className="shrink-0 font-medium">{t("chat.session.about")}</span>
        <span className="truncate">{page.title}</span>
        <button type="button" onClick={() => setPageOff(true)} aria-label={t("chat.session.aboutRemove", { title: page.title })} title={t("chat.session.aboutRemove", { title: page.title })}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-accent/15"><X aria-hidden className="size-3" /></button>
      </span>
    </div>
  ) : panel && pageOff && pageContext?.title ? (
    <div className="px-3 pt-2.5">
      <button type="button" onClick={() => setPageOff(false)} className="rounded-full px-2 py-0.5 text-xs text-muted ring-1 ring-inset ring-line hover:text-fg">
        {t("chat.session.aboutAdd", { title: pageContext.title })}
      </button>
    </div>
  ) : null;

  const footer = (
    <>
      <AnimatePresence>
        {error && (
          <motion.div key="err" role="alert" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
            className="mb-2 flex items-start gap-3 rounded-lg bg-danger-tint px-4 py-3 text-sm text-danger">
            <p className="min-w-0 flex-1">{error}</p>
            <button type="button" onClick={() => setError(null)} aria-label={t("chat.dismissMessage")} className="-m-1 rounded p-1 hover:bg-surface/50"><X aria-hidden className="size-4" /></button>
          </motion.div>
        )}
        {notice && !error && (
          <motion.div key="notice" role="status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
            className="mb-2 flex items-start gap-3 rounded-lg bg-surface px-4 py-3 text-sm">
            <p className="min-w-0 flex-1">
              {notice}
              {noticeHref && <> <Link href={noticeHref} className="text-accent underline-offset-4 hover:underline">{t("chat.notice.review")}</Link></>}
            </p>
            <button type="button" onClick={() => { setNotice(null); setNoticeHref(null); }} aria-label={t("chat.dismiss")} className="-m-1 rounded p-1 text-muted hover:bg-surface-2"><X aria-hidden className="size-4" /></button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {queue.length > 0 && (
          <motion.ul key="queue" aria-label={t("chat.queue.label")} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: EASE }} className="mb-2 space-y-1 overflow-hidden">
            {queue.map((q, i) => (
              <li key={q.id} className="flex items-center gap-2 rounded-md bg-surface-2 py-1.5 pl-3 pr-1 text-sm">
                <span className="shrink-0 text-xs text-muted">{i === 0 ? t("chat.queue.next") : t("chat.queue.then")}</span>
                <span className="min-w-0 flex-1 truncate">{q.text}</span>
                <button type="button" aria-label={t("chat.queue.drop", { text: q.text })} onClick={() => setQueue((x) => x.filter((y) => y.id !== q.id))}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-fg"><X aria-hidden className="size-3.5" /></button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <Composer value={input} onChange={setInput} onSend={(p) => void sendFromComposer(p)} onStop={() => void stop()}
        streaming={streaming} stopping={stopping} sensitive={sensitive} empty={empty} inputRef={inputRef}
        top={chip} inputId={panel ? "assistant-input" : "chat-input"} />
    </>
  );

  if (panel) {
    return (
      <GraphKindContext.Provider value={graphKind}>
        <div className="relative flex h-full min-h-0 flex-col">
          <div className="shrink-0 px-4 pt-3">{threadBar}</div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
            <MuxBanner initial={mux} canFix={canFix} />
            {thread}
          </div>
          <div className="shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-2">{footer}</div>
          <AnimatePresence>
            {drawer && (
              <motion.div key="sessions" role="dialog" aria-label={t("chat.session.saved")}
                className="absolute inset-0 z-20 flex flex-col bg-bg px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3"
                initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.2, ease: EASE }}>
                <div className="mb-2 flex justify-end">
                  <IconButton label={t("chat.session.closeSaved")} onClick={() => setDrawer(false)}><X className="size-4" /></IconButton>
                </div>
                <div className="min-h-0 flex-1">
                  <ConversationList {...listProps} heading
                    onNew={(e) => { startNew(e); setDrawer(false); }}
                    onOpen={(id) => { setDrawer(false); if (id !== activeIdRef.current) onOpenSession?.(id); }} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </GraphKindContext.Provider>
    );
  }

  return (
    <GraphKindContext.Provider value={graphKind}>
    <div className="-mb-28 lg:-mb-16 lg:grid lg:grid-cols-[216px_minmax(0,1fr)] lg:gap-10">
      <aside className="hidden lg:sticky lg:top-0 lg:-mt-9 lg:block lg:h-dvh lg:pb-2 lg:pt-9">
        <ConversationList {...listProps} />
      </aside>
      <AnimatePresence>
        {drawer && (
          <>
            <motion.div key="scrim" className="fixed inset-0 z-50 bg-fg/30 lg:hidden" onClick={() => setDrawer(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            <motion.div key="drawer" role="dialog" aria-modal="true" aria-label={t("chat.thread.conversations")}
              className="fixed inset-y-0 left-0 z-50 flex w-[86vw] max-w-[320px] flex-col bg-bg px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 shadow-float lg:hidden"
              initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}>
              <div className="mb-2 flex items-center justify-between pl-2.5">
                <p className="font-semibold">{t("chat.thread.conversations")}</p>
                <IconButton label={t("chat.thread.closeList")} onClick={() => setDrawer(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="min-h-0 flex-1"><ConversationList {...listProps} onNavigate={() => setDrawer(false)} /></div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <section aria-label={t("chat.thread.conversation")} className="flex min-h-[calc(100dvh-4.5rem)] min-w-0 flex-col pb-[calc(56px+env(safe-area-inset-bottom))] lg:min-h-[calc(100dvh-2.25rem)] lg:pb-0">
        <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col">
          {threadBar}
          <MuxBanner initial={mux} canFix={canFix} />
          {thread}
          <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-20 -mx-2 bg-bg px-2 pb-3 pt-2 lg:bottom-0 lg:pb-6">
            {footer}
          </div>
        </div>
      </section>
    </div>
    </GraphKindContext.Provider>
  );
}

function addedNotice(plan: NonNullable<ComposerSend["plan"]>, t: TFn): string {
  const things = plan.entities.filter((e) => !e.existing).length;
  const facts = plan.facts.length;
  const parts = [things ? t("chat.notice.things", { count: things }) : "", facts ? t("chat.notice.facts", { count: facts }) : ""].filter(Boolean);
  const what = parts.length === 2 ? t("chat.notice.and", { a: parts[0], b: parts[1] }) : parts[0] ?? "";
  return t("chat.notice.added", { parts: what });
}

/** Where "Compact this conversation" cut: earlier turns stay readable, the assistant now uses the summary. */
function SummaryDivider({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-10 rounded-lg bg-surface-2 px-4 py-3 text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 text-left text-muted hover:text-fg">
        <Archive aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{t("chat.thread.summarised")}</span>
        <ChevronRight aria-hidden className={`size-4 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <p className="mt-2 whitespace-pre-line pl-6 text-fg/90">{text}</p>}
    </div>
  );
}

function ThreadBar({ title, startedAt, sensitive, level, canEdit, busy, pinned, unread, compacting, canCompact, onOpenList, onNew, onRename, onDelete, onPin, onUnread, onCompact, panel = false, extra }: {
  title: string | null; startedAt: string | null; sensitive: boolean; level: Sensitivity; canEdit: boolean; busy: boolean;
  pinned: boolean; unread: boolean; compacting: boolean; canCompact: boolean;
  onOpenList: () => void; onNew: (e: MouseEvent) => void;
  onRename: (t: string) => Promise<boolean>; onDelete: () => Promise<boolean>;
  onPin: () => void; onUnread: () => void; onCompact: () => void;
  /** In the Ask panel the list and New buttons always show (the panel is narrow at any screen size). */
  panel?: boolean; extra?: ReactNode;
}) {
  const t = useT();
  const fmt = useFormatDate();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(title ?? "");
  const [saving, setSaving] = useState(false);
  const started = startedAt ? new Date(startedAt) : null;
  const badge = sensitivityBadge(level) ? t(level === "parents" ? "chat.thread.parentsOnly" : "chat.thread.privateItems") : null;

  useEffect(() => { setMode("view"); setDraft(title ?? ""); }, [title]);

  async function save() {
    const next = draft.trim();
    if (!next || next === title) { setMode("view"); return; }
    setSaving(true);
    if (await onRename(next)) setMode("view");
    setSaving(false);
  }

  return (
    <div className={clsx("flex min-h-9 items-center gap-2", panel ? "mb-3" : "mb-8 lg:mb-10")}>
      <IconButton label={t("chat.thread.showList")} className={clsx("-ml-1.5", !panel && "lg:hidden")} onClick={onOpenList}><PanelLeft className="size-[18px]" /></IconButton>
      <div className="min-w-0 flex-1">
        {mode === "rename" ? (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label htmlFor="thread-title" className="sr-only">{t("chat.thread.name")}</label>
            <input id="thread-title" autoFocus value={draft} maxLength={120} disabled={saving}
              onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => { if (e.key === "Escape") { setMode("view"); setDraft(title ?? ""); } }}
              className="h-8 min-w-0 flex-1 rounded-md bg-surface px-2 text-sm font-medium outline-none ring-1 ring-inset ring-accent" />
            <button type="submit" disabled={saving} className="h-8 rounded-md bg-fg px-3 text-sm font-medium text-bg active:scale-[0.97]">{saving ? t("chat.thread.saving") : t("chat.thread.save")}</button>
            <button type="button" onClick={() => { setMode("view"); setDraft(title ?? ""); }} className="h-8 rounded-md px-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">{t("chat.thread.cancel")}</button>
          </form>
        ) : mode === "delete" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" role="group" aria-label={t("chat.thread.deleteQ")}>
            <span className="font-medium text-danger">{t("chat.thread.deleteQ")}</span>
            <span className="hidden text-muted sm:inline">{t("chat.thread.deleteKeeps")}</span>
            <span className="flex gap-1.5">
              <button type="button" autoFocus disabled={saving} onClick={async () => { setSaving(true); if (!(await onDelete())) { setSaving(false); setMode("view"); } }}
                className="h-8 rounded-md bg-danger px-3 font-medium text-white active:scale-[0.97] disabled:opacity-60">{saving ? t("chat.thread.deleting") : t("chat.thread.delete")}</button>
              <button type="button" onClick={() => setMode("view")} className="h-8 rounded-md px-2.5 text-muted hover:bg-surface-2 hover:text-fg">{t("chat.thread.keep")}</button>
            </span>
          </div>
        ) : title ? (
          <div className="min-w-0">
            <h1 className="flex items-center gap-1.5 truncate text-sm font-medium">
              {pinned && <Pin aria-label={t("chat.thread.pinned")} className="size-3.5 shrink-0 text-muted" />}
              <span className="truncate">{title}</span>
            </h1>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
              {badge && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-px text-fg/80">
                  <Lock aria-hidden className="size-3" />{badge}
                </span>
              )}
              {sensitive && !badge && <span className="inline-flex items-center gap-1"><Lock aria-hidden className="size-3" />{t("chat.thread.private")}</span>}
              {started && !Number.isNaN(started.getTime()) && <span suppressHydrationWarning>{t("chat.thread.started", { date: fmt(started, "weekday") })}</span>}
            </p>
          </div>
        ) : (
          <p className={clsx("text-sm text-muted", !panel && "lg:hidden")}>{panel ? t("chat.session.panel") : t("chat.thread.newConversation")}</p>
        )}
      </div>
      {mode === "view" && (
        <div className="flex shrink-0 items-center">
          {canEdit && (
            <ThreadMenu label={t("chat.thread.actions")} items={[
              { label: pinned ? t("chat.thread.unpin") : t("chat.thread.pin"), icon: pinned ? <PinOff /> : <Pin />, onSelect: onPin },
              { label: unread ? t("chat.thread.markRead") : t("chat.thread.markUnread"), icon: unread ? <MailOpen /> : <Mail />, onSelect: onUnread, hint: unread ? undefined : t("chat.thread.markUnreadHint") },
              { label: compacting ? t("chat.thread.compacting") : t("chat.thread.compact"), icon: <Archive />, onSelect: onCompact, disabled: busy || compacting || !canCompact,
                hint: canCompact ? t("chat.thread.compactHint") : t("chat.thread.compactLater") },
              { label: t("chat.thread.rename"), icon: <Pencil />, onSelect: () => setMode("rename") },
              { label: t("chat.thread.delete"), icon: <Trash2 />, onSelect: () => setMode("delete"), danger: true, disabled: busy },
            ]} />
          )}
          <Link href="/chat?new=1" onClick={onNew} aria-label={t("chat.thread.newConversation")} title={t("chat.thread.newConversation")}
            className={clsx("inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg", !panel && "lg:hidden")}>
            <SquarePen className="size-4" aria-hidden />
          </Link>
        </div>
      )}
      {extra}
    </div>
  );
}
