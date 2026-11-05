"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { clsx } from "clsx";
import { Eye, EyeOff, Loader2, Maximize2, Minus, TextSelect, X } from "lucide-react";
import { IconButton } from "@/components/ui";
import { ChatApp, type PageExtras } from "@/components/chat/chat-app";
import type { MuxStatus } from "@/components/chat/mux-banner";
import type { Starter } from "@/components/chat/recency";
import type { ConversationSummary, ConversationView } from "@/lib/assistant/store";
import { pageContextFrom } from "@/lib/assistant/page-context";
import type { PageSelection } from "@/lib/assistant/page-actions";
import { useT } from "@/lib/i18n/client";
import { Mark } from "../mark";
import { ASK_EVENT, type AskDetail } from "./events";
import { clampGeo, dragPosition, leftOf, nudgeGeo, parseGeo, resizeGeo, snapGeo, type Geo, type Viewport } from "./geometry";
import { cleanSelection, lookingAt, sectionKey, viewFor } from "./context";
import { useRegisteredActions, usePageViewInfo } from "./page-actions";
import { RouteActions } from "./route-actions";

const OPEN_KEY = "mg.assistant.open";
const GEO_KEY = "mg.assistant.window";
const EASE = [0.22, 1, 0.36, 1] as const;
const SHEET = [0.32, 0.72, 0, 1] as const;

type Session = {
  conversationId: string | null; conversation: ConversationView | null; conversations: ConversationSummary[];
  mux: MuxStatus; canFix: boolean; starters: Starter[]; graphKind: string;
};

function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private window */ }
}
const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * The assistant as a floating window on every page: a phone-sized card docked to the right (or left) edge, above
 * the page and below dialogs, opened from the launcher at the bottom right, ⌘J / Ctrl+J or "Ask anything". The page
 * behind stays usable. It knows what is open ("Looking at: Lejekontrakt v2 · Library"), what is selected, and what
 * the page lets it do (page actions, see ./page-actions). Same always-active session as /chat and the iOS app; it
 * stays mounted once opened, so an answer keeps writing while it is minimized. On phones it is a full-screen sheet.
 */
export function AssistantPanel() {
  const t = useT();
  const pathname = usePathname() ?? "/";
  const onChat = pathname === "/chat" || pathname.startsWith("/chat/");
  const [open, setOpenState] = useState(false);
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [phone, setPhone] = useState(false);
  const [vp, setVp] = useState<Viewport>({ width: 1440, height: 900 });
  const [geo, setGeo] = useState<Geo | null>(null);
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const busyRef = useRef(false);
  const activeRef = useRef<string | null>(null);
  const askRef = useRef<((q: string) => void) | null>(null);
  const pendingAsk = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const shown = open && !onChat;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Remembered on this device: open or closed, and where the window sits.
  useEffect(() => {
    setOpenState(readStored(OPEN_KEY) === "1");
    const v = viewport();
    setVp(v);
    setGeo(clampGeo(parseGeo(readStored(GEO_KEY)), v));
    setReady(true);
    const mq = window.matchMedia("(max-width: 639px)");
    const onMq = () => setPhone(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    const onResize = () => { const nv = viewport(); setVp(nv); setGeo((g) => (g ? clampGeo(g, nv) : g)); };
    window.addEventListener("resize", onResize);
    return () => { mq.removeEventListener("change", onMq); window.removeEventListener("resize", onResize); };
  }, []);

  const setOpen = useCallback((next: boolean) => {
    if (next && !shownRef.current) {
      const a = document.activeElement as HTMLElement | null;
      returnFocus.current = a && a !== document.body && !panelRef.current?.contains(a) ? a : null;
    }
    setOpenState(next);
    store(OPEN_KEY, next ? "1" : "0");
    if (next) setUnseen(false);
    if (!next) {
      // Focus goes back where it was (or to the launcher), never lost inside a hidden window.
      window.setTimeout(() => {
        const back = returnFocus.current;
        if (back && back.isConnected) back.focus({ preventScroll: true });
        else launcherRef.current?.focus({ preventScroll: true });
      }, 0);
    }
  }, []);

  const saveGeo = useCallback((g: Geo) => { setGeo(g); store(GEO_KEY, JSON.stringify(g)); }, []);

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

  // Focus moves into the window when it opens.
  useEffect(() => {
    if (!shown || !session) return;
    const timer = window.setTimeout(() => {
      if (!panelRef.current?.contains(document.activeElement)) document.getElementById("assistant-input")?.focus({ preventScroll: true });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [shown, session]);

  /* ── What it sees: the open record, the list's view, the selection, the page's actions ─────────────── */

  const [docTitle, setDocTitle] = useState("");
  useEffect(() => {
    const read = () => setDocTitle(document.title);
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [pathname]);
  // The page's own heading names the open record best ("letter-3.docx" where the tab only says "File").
  const [heading, setHeading] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    const read = () => {
      const h = [...document.querySelectorAll<HTMLElement>("main h1")].find((el) => !panelRef.current?.contains(el));
      setHeading(h?.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) || null);
    };
    read();
    const timers = [300, 1200, 3000].map((ms) => window.setTimeout(read, ms));
    return () => timers.forEach((x) => window.clearTimeout(x));
  }, [pathname, shown, docTitle]);
  const record = useMemo(() => pageContextFrom(pathname, heading || docTitle), [pathname, docTitle, heading]);
  const view = usePageViewInfo();
  const registered = useRegisteredActions();
  // Going to another page works everywhere; the count is about what this page offers.
  const actionCount = useMemo(() => new Set(registered.filter((a) => !a.id.startsWith("app.")).map((a) => a.id)).size, [registered]);
  const sKey = sectionKey(pathname);
  const section = sKey ? t(sKey) : null;
  const seeing = lookingAt({ section: view?.section ?? section, title: record?.title ?? null, detail: view?.detail ?? null });

  // Sharing the page is on unless the person turns it off; it comes back on when another page opens.
  const [sharing, setSharing] = useState(true);
  useEffect(() => { setSharing(true); }, [pathname]);

  // The last text selected on the page (not in the window). Clicking into the window keeps it.
  const [selection, setSelection] = useState<PageSelection | null>(null);
  useEffect(() => { setSelection(null); }, [pathname]);
  useEffect(() => {
    let frame = 0;
    const onSel = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sel = document.getSelection();
        const inWindow = (n: Node | null) => !!n && !!panelRef.current?.contains(n);
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          if (!inWindow(document.activeElement)) setSelection(null);
          return;
        }
        if (inWindow(sel.anchorNode)) return;
        const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement ?? null;
        const loc = anchor?.closest("[data-ask-locator]")?.getAttribute("data-ask-locator") ?? null;
        setSelection(cleanSelection(sel.toString(), loc));
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("selectionchange", onSel); };
  }, []);

  const extrasRef = useRef<() => PageExtras | null>(() => null);
  extrasRef.current = () => (sharing
    ? { view: viewFor(view?.section ?? section, view?.detail ?? null), selection, actions: true }
    : null);
  const getExtras = useCallback(() => extrasRef.current(), []);

  async function openSession(id: string) {
    if (busyRef.current) return;
    setLoading(true);
    try {
      await fetch("/api/chat/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: id }) });
    } catch { /* load shows what is active */ }
    await load();
  }

  /* ── Moving and resizing ─────────────────────────────────────────────────────────────────────────── */

  const g = geo ?? clampGeo(null, vp);
  const left = drag?.left ?? leftOf(g, vp);
  const top = drag?.top ?? g.top;
  const gesture = useRef<{ kind: "move" | "side" | "top"; x: number; y: number; start: Geo; left: number; top: number } | null>(null);

  function startGesture(kind: "move" | "side" | "top", e: ReactPointerEvent<HTMLElement>) {
    if (phone || e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button, a, input, textarea, [role=button]")) return;
    e.preventDefault();
    gesture.current = { kind, x: e.clientX, y: e.clientY, start: g, left: leftOf(g, vp), top: g.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveGesture(e: ReactPointerEvent<HTMLElement>) {
    const s = gesture.current;
    if (!s) return;
    const delta = { x: e.clientX - s.x, y: e.clientY - s.y };
    if (s.kind === "move") setDrag(dragPosition(s.start, { left: s.left, top: s.top }, delta, vp));
    else setGeo(resizeGeo(s.start, s.kind, delta, vp));
  }
  function endGesture(e: ReactPointerEvent<HTMLElement>) {
    const s = gesture.current;
    if (!s) return;
    gesture.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (s.kind === "move") {
      const dropped = drag ?? { left: s.left, top: s.top };
      setDrag(null);
      saveGeo(snapGeo(s.start, dropped, vp));
    } else if (geo) {
      saveGeo(geo);
    }
  }
  function onEdgeKey(edge: "side" | "top", e: ReactKeyboardEvent<HTMLElement>) {
    const next = nudgeGeo(g, edge, e.key, e.shiftKey, vp);
    if (!next) return;
    e.preventDefault();
    saveGeo(next);
  }
  function onHeaderKey(e: ReactKeyboardEvent<HTMLElement>) {
    // Alt+← / Alt+→ docks the window to that side (the keyboard way to move it).
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    saveGeo(clampGeo({ ...g, side: e.key === "ArrowLeft" ? "left" : "right" }, vp));
  }

  // Phones: a modal sheet, so Tab stays inside it.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest("[role=combobox][aria-expanded=true], [role=menu], [role=dialog] [role=dialog]")) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key !== "Tab" || !phone || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])")]
      .filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const onAnswered = useCallback(() => { if (!shownRef.current) setUnseen(true); }, []);

  if (!ready) return null;

  const dot = waiting ? "bg-warn" : unseen ? "bg-accent" : null;
  const launcher = !onChat && !shown && (
    <motion.button ref={launcherRef} type="button" onClick={() => setOpen(true)}
      aria-label={waiting ? t("chat.window.openWaiting") : unseen ? t("chat.window.openNew") : t("chat.window.open")}
      title={`${t("chat.window.open")} (⌘J)`}
      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: EASE }}
      className="fixed bottom-5 right-5 z-[45] hidden size-13 items-center justify-center rounded-full bg-fg text-bg shadow-float transition-transform hover:scale-[1.04] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:inline-flex">
      <svg viewBox="0 0 28 28" aria-hidden className="size-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <g transform="translate(4 4) scale(0.8333)">
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
          <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" />
        </g>
      </svg>
      {dot && <span aria-hidden className={clsx("absolute right-0.5 top-0.5 size-3 rounded-full ring-2 ring-bg", dot)} />}
    </motion.button>
  );

  if (!mounted && !shown) return launcher || null;

  const windowButtons = (
    <span className="flex shrink-0 items-center">
      <Link href="/chat" onClick={() => setOpen(false)} aria-label={t("chat.session.fullSize")} title={t("chat.session.fullSize")}
        className="hidden size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:inline-flex">
        <Maximize2 aria-hidden className="size-4" />
      </Link>
      {!phone && <IconButton label={t("chat.window.minimize")} onClick={() => setOpen(false)}><Minus className="size-4" /></IconButton>}
      <IconButton label={t("chat.window.close")} onClick={() => setOpen(false)}><X className="size-4" /></IconButton>
    </span>
  );

  const header = (
    <div onPointerDown={(e) => startGesture("move", e)} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}
      className={clsx("flex shrink-0 items-start gap-2 px-3 pb-1.5 pt-2.5", !phone && "cursor-grab touch-none select-none active:cursor-grabbing")}>
      <button type="button" onKeyDown={onHeaderKey} aria-label={t("chat.window.move")} title={t("chat.window.move")}
        className="mt-0.5 hidden shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-accent sm:block" tabIndex={0}>
        <Mark size={22} />
      </button>
      <div className="min-w-0 flex-1 pt-px">
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted">
          {sharing && seeing ? (
            <>
              <span className="shrink-0">{t("chat.window.lookingAt")}</span>
              <span className="truncate font-medium text-fg" title={seeing}>{seeing}</span>
            </>
          ) : (
            <span className="truncate">{seeing ? t("chat.window.notSharing") : t("chat.window.nothing")}</span>
          )}
          {seeing && (
            <button type="button" onClick={() => setSharing((s) => !s)} aria-pressed={!sharing}
              aria-label={sharing ? t("chat.window.stopSharing") : t("chat.window.share")} title={sharing ? t("chat.window.stopSharing") : t("chat.window.share")}
              className="-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg">
              {sharing ? <Eye aria-hidden className="size-3.5" /> : <EyeOff aria-hidden className="size-3.5" />}
            </button>
          )}
        </p>
        {sharing && (selection || actionCount > 0) && (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            {selection ? (
              <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-accent-tint py-px pl-2 pr-0.5 text-accent">
                <TextSelect aria-hidden className="size-3 shrink-0" />
                <span className="shrink-0">{t("chat.window.selected")}</span>
                <span className="truncate">“{selection.text}”</span>
                <button type="button" onClick={() => setSelection(null)} aria-label={t("chat.window.dropSelection")} title={t("chat.window.dropSelection")}
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-accent/15"><X aria-hidden className="size-2.5" /></button>
              </span>
            ) : (
              <span>{t("chat.window.canDo", { count: actionCount })}</span>
            )}
          </p>
        )}
      </div>
      {windowButtons}
    </div>
  );

  const placed = !phone && geo;
  const originX = g.side === "right" ? "right" : "left";

  return (
    <>
      <RouteActions pathname={pathname} />
      {launcher}
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal={phone && shown ? true : undefined}
        aria-label={t("chat.session.panel")}
        aria-hidden={!shown}
        inert={!shown}
        onKeyDown={onKeyDown}
        initial={false}
        animate={shown
          ? { opacity: 1, scale: 1, y: 0 }
          : phone ? { opacity: 1, scale: 1, y: "100%" } : { opacity: 0, scale: 0.92, y: 24 }}
        transition={phone ? { duration: shown ? 0.3 : 0.22, ease: SHEET } : shown ? { type: "spring", bounce: 0, duration: 0.32 } : { duration: 0.16, ease: EASE }}
        style={{
          ...(placed ? { left, top, width: g.width, height: g.height, transformOrigin: `bottom ${originX}` } : {}),
          visibility: shown ? "visible" : undefined,
        }}
        onAnimationComplete={() => { if (!shownRef.current && panelRef.current) panelRef.current.style.visibility = "hidden"; }}
        className={clsx("fixed flex flex-col overflow-hidden bg-bg",
          phone ? "inset-0 z-[60] pt-[env(safe-area-inset-top)]" : "z-[45] rounded-lg shadow-float ring-1 ring-line")}
      >
        {!phone && (
          <>
            <div role="separator" aria-orientation="vertical" aria-label={t("chat.window.resizeSide")} title={t("chat.window.resizeSide")} tabIndex={0}
              aria-valuemin={340} aria-valuemax={720} aria-valuenow={g.width}
              onPointerDown={(e) => startGesture("side", e)} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}
              onKeyDown={(e) => onEdgeKey("side", e)}
              className={clsx("group absolute inset-y-3 z-30 w-2 cursor-col-resize touch-none", g.side === "right" ? "left-0" : "right-0")}>
              <span aria-hidden className={clsx("absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent", g.side === "right" ? "left-0" : "right-0")} />
            </div>
            <div role="separator" aria-orientation="horizontal" aria-label={t("chat.window.resizeTop")} title={t("chat.window.resizeTop")} tabIndex={0}
              aria-valuemin={420} aria-valuemax={vp.height - 32} aria-valuenow={g.height}
              onPointerDown={(e) => startGesture("top", e)} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}
              onKeyDown={(e) => onEdgeKey("top", e)}
              className="group absolute inset-x-3 top-0 z-30 h-1.5 cursor-row-resize touch-none">
              <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
            </div>
          </>
        )}

        {header}

        <div className="relative min-h-0 flex-1">
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
              pageContext={sharing ? record : null}
              pageExtras={getExtras}
              askRef={askRef}
              onBusy={(b) => { busyRef.current = b; }}
              onActive={(id) => { activeRef.current = id; }}
              onOpenSession={(id) => void openSession(id)}
              onAttention={setWaiting}
              onAnswered={onAnswered}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
              {failed ? (
                <>
                  <p role="alert">{t("chat.session.loadFailed")}</p>
                  <button type="button" onClick={() => void load()} className="h-8 rounded-md bg-fg px-3 font-medium text-bg active:scale-[0.97]">{t("chat.session.retry")}</button>
                </>
              ) : (
                <p role="status" className="inline-flex items-center gap-2"><Loader2 aria-hidden className="size-4 animate-spin" />{t("chat.session.loading")}</p>
              )}
            </div>
          )}
          {loading && session && (
            <div role="status" aria-label={t("chat.session.loading")} className="absolute right-3 top-2 z-30 rounded-full bg-surface p-1.5 shadow-float">
              <Loader2 aria-hidden className="size-4 animate-spin text-muted" />
            </div>
          )}
        </div>
      </motion.div>
    </>
  );
}
