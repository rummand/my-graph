"use client";
/**
 * Live compliance in the wiki editor. After a pause in typing (2.5 s) the page's text is checked against the corpora
 * that apply to it; only paragraphs that changed cost a model call (the server caches the rest). Flagged words get a
 * soft underline; clicking them opens a side note with the rule, why, the rule's own words and its source, "Suggest a
 * fix" (a pending edit to accept) and "Accept deviation" (with a reason). The strip on top sums it up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useT } from "@/lib/i18n/client";
import { checkTarget, countsOf, decideFinding, storedFindings, type FindingView } from "./api";
import { FindingNote, severityTone } from "./finding-note";
import { ComplianceStrip, type StripState } from "./strip";
import { docText, getMarks, isComplianceTr, setCompliance, spanToRange, type Mark } from "./tiptap";

const PAUSE_MS = 2500;

type Note = { id: string; top: number; left: number; mobile: boolean };

export function LiveWikiCompliance({ editor, pageId, title, canEdit = true }: { editor: Editor; pageId: string; title: () => string; canEdit?: boolean }) {
  const t = useT();
  const [state, setState] = useState<StripState>({ phase: "idle", corpora: [], findings: [], counts: countsOf([]), status: null, checked: false });
  const [note, setNote] = useState<Note | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const lastText = useRef<string | null>(null);
  const findingsRef = useRef<FindingView[]>([]);
  const titleRef = useRef(title);
  titleRef.current = title;

  /** Put the underlines where the flagged words are now. */
  const paint = useCallback((findings: FindingView[]) => {
    findingsRef.current = findings;
    if (editor.isDestroyed) return;
    const now = docText(editor.state.doc);
    const marks: Mark[] = [];
    for (const f of findings) {
      if (f.status !== "open" || !f.span || f.verdict === "missing") continue;
      const r = spanToRange(now, f.span);
      if (r) marks.push({ id: f.id, ...r, tone: severityTone(f), approx: !!f.span.approx });
    }
    editor.view.dispatch(setCompliance(editor.state.tr, { marks }));
  }, [editor]);

  const apply = useCallback((findings: FindingView[], extra: Partial<StripState> = {}) => {
    setState((s) => ({ ...s, ...extra, findings, counts: countsOf(findings) }));
    paint(findings);
  }, [paint]);

  const run = useCallback(async () => {
    if (editor.isDestroyed) return;
    const { text } = docText(editor.state.doc);
    if (text === lastText.current) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState((s) => ({ ...s, phase: "checking" }));
    const r = await checkTarget({ targetType: "wiki", targetId: pageId, text, title: titleRef.current() }, ac.signal);
    if (ac.signal.aborted) return;
    if (!r.ok) { setState((s) => ({ ...s, phase: "idle", status: "unavailable" })); return; }
    lastText.current = text;
    const res = r.data.result;
    apply(res.findings, { phase: "idle", corpora: res.corpora, status: res.status, checked: true });
  }, [editor, pageId, apply]);

  const schedule = useCallback((ms = PAUSE_MS) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), ms);
  }, [run]);

  // The last results right away, then a fresh check once the editor settles.
  useEffect(() => {
    let live = true;
    void storedFindings("wiki", pageId).then((r) => {
      if (!live || !r.ok) return;
      apply(r.data.findings, { corpora: r.data.run?.corpora ?? [], checked: !!r.data.run });
    });
    schedule(1200);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); abort.current?.abort(); };
  }, [pageId, apply, schedule]);

  // Re-check after a pause in typing (not for the checker's own marks).
  useEffect(() => {
    const onUpdate = ({ transaction }: { transaction: Parameters<typeof isComplianceTr>[0] }) => { if (!isComplianceTr(transaction)) schedule(); };
    editor.on("update", onUpdate);
    return () => { editor.off("update", onUpdate); };
  }, [editor, schedule]);

  const open = useCallback((id: string) => {
    const m = getMarks(editor.state).marks.find((x) => x.id === id);
    const mobile = window.innerWidth < 640;
    let top = 120, left = 16;
    if (m) {
      try {
        const c = editor.view.coordsAtPos(m.to);
        top = c.bottom + 8;
        left = Math.max(8, Math.min(c.left - 40, window.innerWidth - 384));
      } catch { /* position gone */ }
    }
    if (top > window.innerHeight - 220) top = Math.max(16, top - 300);
    setNote({ id, top, left, mobile });
    editor.view.dispatch(setCompliance(editor.state.tr, { active: id }));
  }, [editor]);

  useEffect(() => {
    const dom = editor.view.dom;
    const h = (e: Event) => open((e as CustomEvent<{ id: string }>).detail.id);
    dom.addEventListener("compliance-pick", h);
    return () => dom.removeEventListener("compliance-pick", h);
  }, [editor, open]);

  const close = useCallback(() => {
    setNote(null);
    setPendingId(null);
    if (!editor.isDestroyed) editor.view.dispatch(setCompliance(editor.state.tr, { active: null, pending: null }));
  }, [editor]);

  useEffect(() => {
    if (!note) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [note, close]);

  /** "Suggest a fix": show the replacement as a pending edit in the text. */
  const suggest = useCallback((f: FindingView) => {
    if (!f.suggestion) return;
    const m = getMarks(editor.state).marks.find((x) => x.id === f.id);
    const atEnd = f.verdict === "missing" || !m;
    editor.view.dispatch(setCompliance(editor.state.tr, { pending: { id: f.id, from: m?.from ?? 0, to: m?.to ?? 0, text: f.suggestion, atEnd }, active: f.id }));
    setPendingId(f.id);
    if (!note || note.id !== f.id) open(f.id);
  }, [editor, note, open]);

  const acceptFix = useCallback(async () => {
    const p = getMarks(editor.state).pending;
    if (!p) return;
    editor.view.dispatch(setCompliance(editor.state.tr, { pending: null, active: null }));
    if (p.atEnd) editor.chain().focus().insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: p.text }] }).run();
    else editor.chain().focus().insertContentAt({ from: p.from, to: p.to }, p.text).run();
    setPendingId(null);
    setNote(null);
    const r = await decideFinding(p.id, { action: "fixed" });
    const left = findingsRef.current.filter((f) => f.id !== p.id);
    apply(r.ok ? r.data.findings : left);
    schedule(800);
  }, [editor, apply, schedule]);

  const discardFix = useCallback(() => {
    editor.view.dispatch(setCompliance(editor.state.tr, { pending: null }));
    setPendingId(null);
  }, [editor]);

  const onChanged = useCallback((findings: FindingView[]) => { apply(findings); }, [apply]);
  const focusFinding = useCallback((f: FindingView) => {
    const m = getMarks(editor.state).marks.find((x) => x.id === f.id);
    if (!m) return;
    editor.commands.setTextSelection(m.from);
    editor.commands.scrollIntoView();
    setTimeout(() => open(f.id), 50);
  }, [editor, open]);

  const current = useMemo(() => state.findings.find((f) => f.id === note?.id) ?? null, [state.findings, note]);

  return (
    <>
      <div className="px-3 pt-2 sm:px-6">
        <ComplianceStrip state={state} canEdit={canEdit} onFocus={focusFinding} onSuggest={suggest} onChanged={onChanged} />
      </div>
      {note && current && (
        <div className={note.mobile ? "fixed inset-x-2 bottom-20 z-50" : "fixed z-50 w-[min(376px,calc(100vw-16px))]"}
          style={note.mobile ? undefined : { top: note.top, left: note.left }}>
          <FindingNote f={current} canEdit={canEdit} onSuggest={suggest} onChanged={(fs) => { onChanged(fs); close(); }} onClose={close}
            pending={pendingId === current.id ? { onAccept: () => void acceptFix(), onDiscard: discardFix } : null} />
        </div>
      )}
      <span className="sr-only" aria-live="polite">{state.phase === "checking" ? t("compliance.strip.checking", { corpora: state.corpora.map((c) => c.name).join(", ") }) : ""}</span>
    </>
  );
}
