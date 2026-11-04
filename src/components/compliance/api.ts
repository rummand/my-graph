/** Browser calls to /api/compliance (client-safe; types only from the server library). */
import type { CheckResult, FindingView } from "@/lib/compliance";
import type { Counts } from "@/lib/compliance/pure";

export type { CheckResult, FindingView, Counts };
export type TargetType = "wiki" | "artifact" | "message" | "change_set" | "node";

export type LastRun = { id: string; status: string; corpora: { id: string; name: string }[]; rulesChecked: number; muxCalls: number; paragraphs: number; paragraphsCached: number; ms: number | null; at: string; finishedAt: string | null } | null;
export type Stored = { findings: FindingView[]; counts: Counts; run: LastRun; effective: string[]; canEdit: boolean };
export type Choice = { own: string[] | null; graphDefault: string[] | null; effective: string[]; corpora: { id: string; name: string; status: string; kind: string; binding: string; checkByDefault: boolean }[]; canEdit?: boolean };

type Res<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<Res<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? "" };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: "" };
  }
}

export function checkTarget(input: { targetType: TargetType; targetId: string; text?: string; content?: unknown; title?: string; missing?: boolean }, signal?: AbortSignal) {
  return call<{ result: CheckResult }>("/api/compliance/check", { method: "POST", json: input, signal });
}

export function storedFindings(targetType: TargetType, targetId: string) {
  return call<Stored>(`/api/compliance/findings?targetType=${targetType}&targetId=${targetId}`);
}

export function decideFinding(id: string, body: { action: "accept"; reason: string } | { action: "fixed" } | { action: "reopen" }) {
  return call<{ findings: FindingView[] }>(`/api/compliance/findings/${id}`, { method: "POST", json: body });
}

export function acknowledge(input: { targetType: TargetType; targetId: string; reason: string; severities?: string[] }) {
  return call<{ accepted: number; findings: FindingView[] }>("/api/compliance/acknowledge", { method: "POST", json: input });
}

export function getChoice(targetType: TargetType | "graph", targetId = "") {
  return call<Choice>(`/api/compliance/targets?targetType=${targetType}&targetId=${targetId}`);
}

export function putChoice(targetType: TargetType | "graph", targetId: string, corpusIds: string[] | null) {
  return call<Choice>("/api/compliance/targets", { method: "PUT", json: { targetType, targetId, corpusIds } });
}

/** Where a rule's source opens: the library item, at its page when known. */
export function sourceHref(f: Pick<FindingView, "rule">): string | null {
  if (!f.rule.sourceId) return null;
  const page = typeof f.rule.locator?.page === "number" ? `#page=${f.rule.locator.page}` : "";
  return `/library/${f.rule.sourceId}${page}`;
}

export function countsOf(findings: FindingView[]): Counts {
  const c: Counts = { blocker: 0, major: 0, minor: 0, info: 0, missing: 0, open: 0, accepted: 0 };
  for (const f of findings) {
    if (f.status === "accepted") { c.accepted++; continue; }
    if (f.status !== "open") continue;
    c.open++;
    if (f.verdict === "missing") c.missing++;
    const s = f.rule.severity as keyof Counts;
    if (s === "blocker" || s === "major" || s === "minor" || s === "info") c[s]++;
  }
  return c;
}
