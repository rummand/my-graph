"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Loader2, Maximize2, X } from "lucide-react";
import { IconButton } from "@/components/ui";
import { ChatApp } from "@/components/chat/chat-app";
import type { MuxStatus } from "@/components/chat/mux-banner";
import type { Starter } from "@/components/chat/recency";
import type { ConversationSummary, ConversationView } from "@/lib/assistant/store";
import { pageContextFrom } from "@/lib/assistant/page-context";
import { useT } from "@/lib/i18n/client";
import { ASK_EVENT, type AskDetail } from "./events";

const OPEN_KEY = "mg.assistant.open";
const WIDTH_KEY = "mg.assistant.width";
const DEFAULT_W = 440;
const MIN_W = 360;
const SHEET = [0.32, 0.72, 0, 1] as const;

type Session = {
  conversationId: string | null; conversation: ConversationView | null; conversations: ConversationSummary[];
  mux: MuxStatus; canFix: boolean; starters: Starter[]; graphKind: string;
};

const maxW = () => Math.max(MIN_W, Math.min(960, window.innerWidth - 320));
const clampW = (w: number) => Math.round(Math.min(maxW(), Math.max(MIN_W, w)));

function readStored<T>(key: string, parse: (s: string) => T | null, fallback: T): T {
  try { const s = window.localStorage.getItem(key); return s === null ? fallback : parse(s) ?? fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private window */ }
}

/**
 * The assistant beside every page: "Ask anything" or ⌘J / Ctrl+J opens it on the right (a full-height sheet on
 * phones), in the same always-active session as /chat, other devices and the iOS app. Questions carry what is open
 * ("About: Bo Madsen"). It stays mounted once opened, so an answer keeps writing while the panel is closed.
 */
export function AssistantPanel() {
  const t = useT();
  const pathname = usePathname() ?? "/";
  const onChat = pathname === "/chat" || pathname.startsWith("/chat/");
  const [open, setOpenState] = useState(false);
  const [width, setWidth] = useState(DEFAULT_W);
  const [mounted, setMounted] = useState(false);
  const [phone, setPhone] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);
  const activeRef = useRef<string | null>(null);
  const askRef = useRef<((q: string) => void) | null>(null);
  const pendingAsk = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const shown = open && !onChat;

  // Remembered between visits: open or closed, and how wide.
  useEffect(() => {
    setOpenState(readStored(OPEN_KEY, (s) => s === "1", false));
    setWidth(readStored(WIDTH_KEY, (s) => (Number.isFinite(Number(s)) ? clampW(Number(s)) : null), DEFAULT_W));
    const mq = window.matchMedia("(max-width: 639px)");
    const onMq = () => setPhone(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    return () => mq.removeEventListener("change", onMq);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    store(OPEN_KEY, next ? "1" : "0");
  }, []);

  // The page beside it makes room on wide screens.
  useEffect(() => {
    const root = document.documentElement;
    if (shown && !phone) { root.dataset.assistant = "open"; root.style.setProperty("--assistant-w", `${width}px`); }
    else delete root.dataset.assistant;
    return () => { delete root.dataset.assistant; };
  }, [shown, phone, width]);

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const res = await fetch("/api/chat/active", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Session;
      activeRef.current = body.conversationId;
      setSession(body);
      setSessionKey((k) => k + 1);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Opening: load the active session, or check it is still the active one (it may have changed on another device).
  useEffect(() => {
    if (!shown) return;
    setMounted(true);
    if (!session) { if (!loading) void load(); return; }
    if (busyRef.current) return;
    const ac = new AbortController();
    void fetch("/api/chat/active?light=1", { cache: "no-store", signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { conversationId: string | null } | null) => { if (b && b.conversationId !== activeRef.current && !busyRef.current) void load(); })
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // ⌘J / Ctrl+J anywhere; on /chat it goes to the chat's own box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      if (onChat) { document.getElementById("chat-input")?.focus(); return; }
      setOpen(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onChat, setOpen]);

  // "Ask anything" in the shell.
  useEffect(() => {
    const onAsk = (e: Event) => {
      if (onChat) return;
      const d = (e as CustomEvent<AskDetail>).detail;
      d.handled = true;
      setOpen(true);
      if (d.question) {
        if (askRef.current) askRef.current(d.question);
        else pendingAsk.current = d.question;
      } else {
        window.setTimeout(() => document.getElementById("assistant-input")?.focus({ preventScroll: true }), 80);
      }
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [onChat, setOpen]);

  // A question asked before the session had loaded goes out once it has.
  useEffect(() => {
    if (!session || !pendingAsk.current) return;
    const timer = window.setTimeout(() => {
      const q = pendingAsk.current;
      if (q && askRef.current) { pendingAsk.current = null; askRef.current(q); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [session, sessionKey]);

  // Focus the box when it opens.
  useEffect(() => {
    if (!shown || !session) return;
    const timer = window.setTimeout(() => {
      if (!panelRef.current?.contains(document.activeElement)) document.getElementById("assistant-input")?.focus({ preventScroll: true });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [shown, session]);

  // What is open: the path, and its title once the page has set it.
  const [docTitle, setDocTitle] = useState("");
  useEffect(() => {
    const read = () => setDocTitle(document.title);
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [pathname]);
  const pageContext = useMemo(() => pageContextFrom(pathname, docTitle), [pathname, docTitle]);

  async function openSession(id: string) {
    if (busyRef.current) return;
    setLoading(true);
    try {
      await fetch("/api/chat/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: id }) });
    } catch { /* load shows what is active */ }
    await load();
  }

  // Resize by dragging the left edge (or with the arrow keys on it).
  const dragging = useRef(false);
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragging.current) setWidth(clampW(window.innerWidth - e.clientX));
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    store(WIDTH_KEY, String(width));
  }
  function onHandleKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 80 : 24;
    const next = e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step : null;
    if (next === null) return;
    e.preventDefault();
    const w = clampW(next);
    setWidth(w);
    store(WIDTH_KEY, String(w));
  }

  if (!mounted && !shown) return null;

  const actions = (
    <span className="flex shrink-0 items-center">
      <Link href="/chat" onClick={() => setOpen(false)} aria-label={t("chat.session.fullSize")} title={t("chat.session.fullSize")}
        className="hidden size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:inline-flex">
        <Maximize2 aria-hidden className="size-4" />
      </Link>
      <IconButton label={t("chat.session.close")} onClick={() => setOpen(false)}><X className="size-4" /></IconButton>
    </span>
  );

  return (
    <motion.aside
      ref={panelRef}
      aria-label={t("chat.session.panel")}
      aria-hidden={!shown}
      inert={!shown}
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest("[role=combobox][aria-expanded=true], [role=menu]")) setOpen(false); }}
      initial={false}
      animate={shown ? { x: 0, y: 0, opacity: 1 } : phone ? { y: "100%", x: 0, opacity: 1 } : { x: "100%", y: 0, opacity: 0.6 }}
      transition={{ duration: shown ? 0.3 : 0.22, ease: SHEET }}
      style={{ width: phone ? undefined : width, visibility: shown ? "visible" : undefined }}
      onAnimationComplete={() => { if (!shown && panelRef.current) panelRef.current.style.visibility = "hidden"; }}
      className="fixed inset-0 z-[60] flex flex-col bg-bg pt-[env(safe-area-inset-top)] sm:left-auto sm:shadow-float sm:ring-1 sm:ring-line"
    >
      <div role="separator" aria-orientation="vertical" aria-label={t("chat.session.resize")} title={t("chat.session.resize")} tabIndex={0}
        aria-valuemin={MIN_W} aria-valuemax={960} aria-valuenow={width}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onHandleKey}
        className="group absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize touch-none sm:block">
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>

      {session ? (
        <ChatApp
          key={sessionKey}
          variant="panel"
          conversations={session.conversations}
          conversation={session.conversation}
          mux={session.mux}
          canFix={session.canFix}
          starters={session.starters}
          graphKind={session.graphKind}
          pageContext={pageContext}
          askRef={askRef}
          onBusy={(b) => { busyRef.current = b; }}
          onActive={(id) => { activeRef.current = id; }}
          onOpenSession={(id) => void openSession(id)}
          panelActions={actions}
        />
      ) : (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-4 pt-3">
            <p className="text-sm font-medium">{t("chat.session.panel")}</p>
            {actions}
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
            {failed ? (
              <>
                <p role="alert">{t("chat.session.loadFailed")}</p>
                <button type="button" onClick={() => void load()} className="h-8 rounded-md bg-fg px-3 font-medium text-bg active:scale-[0.97]">{t("chat.session.retry")}</button>
              </>
            ) : (
              <p role="status" className="inline-flex items-center gap-2"><Loader2 aria-hidden className="size-4 animate-spin" />{t("chat.session.loading")}</p>
            )}
          </div>
        </div>
      )}
      {loading && session && (
        <div role="status" aria-label={t("chat.session.loading")} className="absolute right-3 top-14 z-30 rounded-full bg-surface p-1.5 shadow-float">
          <Loader2 aria-hidden className="size-4 animate-spin text-muted" />
        </div>
      )}
    </motion.aside>
  );
}
