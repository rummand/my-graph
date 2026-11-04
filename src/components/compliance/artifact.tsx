"use client";
/**
 * Compliance in the document editor: the same live check as the wiki (3 s after the last change, only changed blocks
 * cost a model call), shown as a strip above the blocks; "Suggest a fix" replaces the flagged words inside their block
 * once accepted. Before publishing, `PublishCompliance` sums up a full check; with blockers it asks for a reason
 * ("Publish anyway"), which is recorded, and it can add a compliance appendix to the published document.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { newId, type ArtifactContent, type Block, type Citation, type Section } from "@/lib/artifacts/content";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { acknowledge, checkTarget, countsOf, storedFindings, type CheckResult, type FindingView } from "./api";
import { FindingIcon, findingHeadline } from "./finding-note";
import { ComplianceStrip, type StripState } from "./strip";

const PAUSE_MS = 3000;
export const APPENDIX_ID = "compliance-appendix";

/** Replace the flagged words inside their block (text, heading, quote). Null when that block can't be changed in place. */
export function fixInContent(c: ArtifactContent, f: FindingView): ArtifactContent | null {
  if (!f.suggestion) return null;
  if (f.verdict === "missing" || !f.span) {
    const last = c.sections[c.sections.length - 1];
    if (!last) return null;
    const block: Block = { id: newId(), type: "text", text: f.suggestion };
    return { ...c, sections: c.sections.map((s) => (s.id === last.id ? { ...s, blocks: [...s.blocks, block] } : s)) };
  }
  const blockId = f.span.block;
  if (!blockId) return null;
  let done = false;
  const sections = c.sections.map((s) => ({
    ...s,
    blocks: s.blocks.map((b) => {
      if (done || b.id !== blockId || (b.type !== "text" && b.type !== "heading" && b.type !== "quote")) return b;
      const at = b.text.indexOf(f.span!.text);
      if (at < 0) return b;
      done = true;
      return { ...b, text: b.text.slice(0, at) + f.suggestion + b.text.slice(at + f.span!.text.length) };
    }),
  }));
  return done ? { ...c, sections } : null;
}

export function ArtifactCompliance({ artifactId, title, content, canEdit, onFix }: {
  artifactId: string; title: string; content: ArtifactContent; canEdit: boolean;
  /** Apply a fix to the document (it becomes an unsaved change, like typing). */
  onFix: (c: ArtifactContent) => void;
}) {
  const [state, setState] = useState<StripState>({ phase: "idle", corpora: [], findings: [], counts: countsOf([]), status: null, checked: false });
  const [pending, setPending] = useState<{ id: string; manual: boolean } | null>(null);
  const last = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef({ title, content });
  latest.current = { title, content };

  const apply = useCallback((findings: FindingView[], extra: Partial<StripState> = {}) => {
    setState((s) => ({ ...s, ...extra, findings, counts: countsOf(findings) }));
  }, []);

  const run = useCallback(async () => {
    const { title: tt, content: cc } = latest.current;
    if (cc.draft?.status === "running") return;
    const key = JSON.stringify([tt, cc.subtitle, cc.sections]);
    if (key === last.current) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState((s) => ({ ...s, phase: "checking" }));
    const r = await checkTarget({ targetType: "artifact", targetId: artifactId, content: { ...cc, draft: null }, title: tt }, ac.signal);
    if (ac.signal.aborted) return;
    if (!r.ok) { setState((s) => ({ ...s, phase: "idle", status: "unavailable" })); return; }
    last.current = key;
    apply(r.data.result.findings, { phase: "idle", corpora: r.data.result.corpora, status: r.data.result.status, checked: true });
  }, [artifactId, apply]);

  useEffect(() => {
    let live = true;
    void storedFindings("artifact", artifactId).then((r) => {
      if (live && r.ok) apply(r.data.findings, { corpora: r.data.run?.corpora ?? [], checked: !!r.data.run });
    });
    return () => { live = false; };
  }, [artifactId, apply]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), last.current === null ? 1200 : PAUSE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [title, content, run]);

  useEffect(() => () => abort.current?.abort(), []);

  const suggest = (f: FindingView) => setPending({ id: f.id, manual: !fixInContent(latest.current.content, f) });
  const pendingFor = (f: FindingView) => (pending?.id === f.id ? {
    manual: pending.manual,
    onAccept: () => {
      const next = fixInContent(latest.current.content, f);
      setPending(null);
      if (next) { onFix(next); apply(state.findings.filter((x) => x.id !== f.id)); }
    },
    onDiscard: () => setPending(null),
  } : null);

  return <ComplianceStrip state={state} canEdit={canEdit} onSuggest={suggest} pendingFor={pendingFor} onChanged={(fs) => apply(fs)} />;
}

/* ── Before publishing ──────────────────────────────────────────────────────────────────────────────────── */

/** The appendix: the rules it was checked against and what was found or kept. Replaces an earlier appendix. */
export function withAppendix(c: ArtifactContent, r: Pick<CheckResult, "corpora" | "findings">, t: ReturnType<typeof useT>, date: string): ArtifactContent {
  const kept = r.findings.filter((f) => f.status === "open" || f.status === "accepted");
  // Each row cites the rule's own source, so the appendix is sourced like every other claim.
  const cites = new Map<string, Citation>();
  for (const f of kept) {
    if (!f.rule.sourceId || cites.has(f.rule.id)) continue;
    cites.set(f.rule.id, { id: `cmp${f.rule.id.replace(/-/g, "").slice(0, 12)}`, kind: "source", sourceId: f.rule.sourceId, label: `${f.rule.corpusName} ${f.rule.ref}`.slice(0, 200), quote: f.rule.quote?.slice(0, 600) ?? null });
  }
  const rows = kept.map((f) => ({
    cells: [`${f.rule.corpusName} ${f.rule.ref}`.slice(0, 300), f.status === "accepted" ? t("compliance.appendix.kept") : t("compliance.appendix.open"), (f.status === "accepted" ? f.acceptedReason ?? "" : f.explanation).slice(0, 300)],
    cites: cites.has(f.rule.id) ? [cites.get(f.rule.id)!.id] : [],
  }));
  const marks = [...cites.values()].slice(0, 6).map((x) => `[^${x.id}]`).join("");
  const blocks: Block[] = [{ id: newId(), type: "text", text: `${t("compliance.appendix.lead", { corpora: r.corpora.map((x) => x.name).join(", "), date })}${marks}` }];
  if (rows.length) blocks.push({ id: newId(), type: "table", columns: [t("compliance.appendix.rule"), t("compliance.appendix.outcome"), t("compliance.appendix.note")], rows });
  else blocks.push({ id: newId(), type: "text", text: t("compliance.appendix.ok") });
  const section: Section = { id: APPENDIX_ID, title: t("compliance.appendix.title"), blocks };
  const have = new Set(c.citations.map((x) => x.id));
  return { ...c, sections: [...c.sections.filter((s) => s.id !== APPENDIX_ID), section], citations: [...c.citations, ...[...cites.values()].filter((x) => !have.has(x.id))] };
}

export function PublishCompliance({ artifactId, title, content, onCancel, onPublish, confirmLabel, cancelLabel }: {
  artifactId: string; title: string; content: ArtifactContent;
  onCancel: () => void;
  /** Publish, with the content to save first when an appendix was added. */
  onPublish: (withContent: ArtifactContent | null) => Promise<void> | void;
  confirmLabel: string; cancelLabel: string;
}) {
  const t = useT();
  const fmt = useFormatDate();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [reason, setReason] = useState("");
  const [appendix, setAppendix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void checkTarget({ targetType: "artifact", targetId: artifactId, content: { ...content, sections: content.sections.filter((s) => s.id !== APPENDIX_ID), draft: null }, title, missing: true }).then((r) => {
      if (!live) return;
      setChecking(false);
      if (r.ok) setResult(r.data.result);
    });
    return () => { live = false; };
    // Check once, as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId]);

  const open = result?.findings.filter((f) => f.status === "open") ?? [];
  const blockers = open.filter((f) => f.rule.severity === "blocker");
  const needReason = blockers.length > 0;

  async function go() {
    setBusy(true); setError(null);
    if (needReason) {
      const r = await acknowledge({ targetType: "artifact", targetId: artifactId, reason });
      if (!r.ok) { setBusy(false); setError(r.error || t("compliance.errors.failed")); return; }
      if (result) setResult({ ...result, findings: r.data.findings });
      if (appendix && result) { await onPublish(withAppendix(content, { corpora: result.corpora, findings: r.data.findings }, t, fmt(new Date()))); setBusy(false); return; }
    } else if (appendix && result) {
      await onPublish(withAppendix(content, result, t, fmt(new Date())));
      setBusy(false);
      return;
    }
    await onPublish(null);
    setBusy(false);
  }

  return (
    <div className="mt-4 border-t border-line pt-4 text-sm">
      <p className="font-medium">{t("compliance.publish.title")}</p>
      {checking ? (
        <p className="mt-2 flex items-center gap-2 text-muted"><LoaderCircle aria-hidden className="size-4 animate-spin" />{t("compliance.publish.checking")}</p>
      ) : !result || !result.corpora.length ? (
        <p className="mt-2 text-muted">{t("compliance.publish.notChecked")}</p>
      ) : !open.length ? (
        <p className="mt-2 flex items-center gap-2 text-muted"><ShieldCheck aria-hidden className="size-4" />{t("compliance.publish.clean", { count: result.corpora.length })}</p>
      ) : (
        <>
          <p className="mt-2 text-muted">{t("compliance.publish.found", { corpora: result.corpora.map((c) => c.name).join(", ") })}</p>
          <ul className="mt-2 max-h-48 space-y-1.5 overflow-auto">
            {open.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <FindingIcon f={f} className="mt-0.5 size-4" />
                <span className="min-w-0"><span className="block">{findingHeadline(t, f)}</span>{f.explanation && <span className="block text-xs text-muted">{f.explanation}</span>}</span>
              </li>
            ))}
          </ul>
          {needReason && (
            <div className="mt-3 grid gap-1.5">
              <p className="text-danger">{t("compliance.publish.blockerLead")}</p>
              <label htmlFor="publish-reason" className="font-medium">{t("compliance.publish.reason")}</label>
              <Textarea id="publish-reason" rows={2} value={reason} placeholder={t("compliance.publish.reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
        </>
      )}
      {result && result.corpora.length > 0 && (
        <label className="mt-3 flex items-start gap-2">
          <input type="checkbox" checked={appendix} onChange={(e) => setAppendix(e.target.checked)} className="mt-1 accent-[var(--fg)]" />
          <span><span className="block">{t("compliance.publish.appendix")}</span><span className="block text-xs text-muted">{t("compliance.publish.appendixHint")}</span></span>
        </label>
      )}
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={needReason ? "danger" : "primary"} disabled={busy || checking || (needReason && reason.trim().length < 5)} onClick={() => void go()}>
          {needReason ? t("compliance.publish.anyway") : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
