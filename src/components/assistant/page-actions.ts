/**
 * The page-action registry (browser). Any page or component says what the assistant may do on it:
 *
 *   usePageActions([{ id: "library.move_files", title: "Move files to a folder", description: "…",
 *     input: z.object({ fileIds: z.array(z.string()), folderId: z.string() }), danger: "change",
 *     confirm: (i) => `Move ${i.fileIds.length} files to Tax?`, run: async (i) => { … } }], [deps]);
 *
 * The Ask window sends the list (names prefixed `page_`) with each question. When the model calls one, the window
 * validates the input against the schema and runs it: "read" actions at once, "change" actions only after the person
 * approved the card in the window. Actions run as the person through the normal API routes (which re-check access).
 *
 * Also here: `usePageView` (what a list shows: folder, filter) for the window's "Looking at" line and the question.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { z } from "zod";
import { actionToolName, type ActionDanger, type ActionManifest, type ClientActionOutcome } from "@/lib/assistant/page-actions";

export type PageActionResult = { summary?: string; data?: unknown } | string | void;

export type PageAction<I = unknown> = {
  /** Stable id, e.g. "library.move_files" (becomes the tool name page_library_move_files). */
  id: string;
  /** What the person reads: "Move files to a folder". */
  title: string;
  /** For the model: when to use it, what the input means. */
  description: string;
  input: z.ZodType<I>;
  danger: ActionDanger;
  /** The approval card's question for a change: "Move 3 files to Money › Tax?". */
  confirm?: (input: I) => string;
  /** Shown under the question on the card (what exactly will change). */
  preview?: (input: I) => string | null;
  run: (input: I) => Promise<PageActionResult> | PageActionResult;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAction = PageAction<any>;

/** Typed helper: write each action with its own input type, then put several in one `usePageActions` list. */
export function defineAction<I>(a: PageAction<I>): AnyAction {
  return a as AnyAction;
}

/* ── Store ───────────────────────────────────────────────────────────────────────────────────────────── */

function createRegistry<E>() {
  const entries = new Map<string, E[]>();
  const listeners = new Set<() => void>();
  let snapshot: E[] = [];
  const emit = () => { snapshot = [...entries.values()].flat(); for (const l of listeners) l(); };
  return {
    get: () => snapshot,
    set: (key: string, value: E[]) => { entries.set(key, value); emit(); },
    remove: (key: string) => { if (entries.delete(key)) emit(); },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

const actionStore = createRegistry<AnyAction>();
let seq = 0;

/** Register actions (pure entry point; returns the unregister function). Later registrations win on the same id. */
export function registerPageActions(actions: AnyAction[]): () => void {
  const key = `r${++seq}`;
  actionStore.set(key, actions);
  return () => actionStore.remove(key);
}

/** Every action registered right now (later registrations win on the same id). */
export function currentPageActions(): AnyAction[] {
  const byId = new Map<string, AnyAction>();
  for (const a of actionStore.get()) byId.set(a.id, a);
  return [...byId.values()];
}

export function useRegisteredActions(): AnyAction[] {
  return useSyncExternalStore(actionStore.subscribe, actionStore.get, () => EMPTY);
}
const EMPTY: AnyAction[] = [];

/**
 * Register this component's actions while it is mounted. `run` and `confirm` always see the latest props (the
 * registration itself changes only when `deps` change, so the list sent with a question stays stable).
 */
export function usePageActions(actions: AnyAction[], deps: unknown[] = []): void {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    const proxied: AnyAction[] = latest.current.map((a) => ({
      ...a,
      run: (input: unknown) => (latest.current.find((x) => x.id === a.id) ?? a).run(input),
      confirm: a.confirm ? (input: unknown) => (latest.current.find((x) => x.id === a.id) ?? a).confirm!(input) : undefined,
      preview: a.preview ? (input: unknown) => (latest.current.find((x) => x.id === a.id) ?? a).preview!(input) : undefined,
    }));
    return registerPageActions(proxied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ── Manifest, validation, running ───────────────────────────────────────────────────────────────────── */

function schemaOf(input: z.ZodType): Record<string, unknown> {
  try {
    const s = z.toJSONSchema(input, { unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    return s;
  } catch {
    return { type: "object" };
  }
}

/** What goes to the server with a question. */
export function toManifest(actions: AnyAction[]): ActionManifest[] {
  const seen = new Set<string>();
  const out: ActionManifest[] = [];
  for (const a of actions) {
    const name = actionToolName(a.id);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, title: a.title.slice(0, 120), description: a.description.slice(0, 600), danger: a.danger, input: schemaOf(a.input) });
    if (out.length >= 40) break;
  }
  return out;
}

export function findAction(actions: AnyAction[], name: string): AnyAction | null {
  return actions.find((a) => actionToolName(a.id) === name) ?? null;
}

/**
 * Does running this need the person's approval first? Every "change" action does, and so does any action the
 * server marked as a change (the stricter of the two wins).
 */
export function needsApproval(action: Pick<AnyAction, "danger"> | null, serverDanger?: ActionDanger): boolean {
  return action?.danger === "change" || serverDanger === "change" || !action;
}

export type Prepared =
  | { ok: true; action: AnyAction; input: unknown; approval: boolean; question: string; preview: string | null }
  | { ok: false; outcome: ClientActionOutcome };

/** Check a call against what the page offers now: the action must still be here and the input must fit. */
export function prepareCall(actions: AnyAction[], call: { name: string; input: unknown; danger?: ActionDanger }): Prepared {
  const action = findAction(actions, call.name);
  if (!action) return { ok: false, outcome: { status: "unavailable", error: "This page no longer offers that action (the person may have moved to another page)." } };
  const parsed = action.input.safeParse(call.input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, outcome: { status: "failed", error: `The input doesn't fit: ${issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid"}.` } };
  }
  let question = action.title;
  let preview: string | null = null;
  try { if (action.confirm) question = action.confirm(parsed.data); } catch { /* keep the title */ }
  try { if (action.preview) preview = action.preview(parsed.data); } catch { /* none */ }
  return { ok: true, action, input: parsed.data, approval: needsApproval(action, call.danger), question, preview };
}

/** Run a prepared call; errors become a "failed" outcome the model can read. */
export async function runPrepared(p: Extract<Prepared, { ok: true }>): Promise<ClientActionOutcome> {
  try {
    const r = await p.action.run(p.input);
    if (typeof r === "string") return { status: "done", summary: r.slice(0, 300) };
    if (r && typeof r === "object") return { status: "done", summary: r.summary?.slice(0, 300) ?? null, result: clip(r.data) };
    return { status: "done" };
  } catch (e) {
    return { status: "failed", error: e instanceof Error && e.message ? e.message.slice(0, 500) : "It didn't work." };
  }
}

/** Results go to the model: keep them small. */
function clip(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    return s.length <= 5000 ? v : `${s.slice(0, 5000)}…`;
  } catch {
    return undefined;
  }
}

/** For actions: fetch JSON from an app route and turn `{ error }` into an Error with the server's words. */
export async function callApi<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `The server said no (${res.status}).`);
  return body as T;
}

/* ── Page view: what a list shows (folder, filter), for "Looking at" and the question ────────────────── */

export type PageViewInfo = { section?: string | null; detail?: string | null };

const viewStore = createRegistry<PageViewInfo>();

export function usePageView(view: PageViewInfo | null): void {
  const section = view?.section ?? null;
  const detail = view?.detail ?? null;
  useEffect(() => {
    if (!section && !detail) return;
    return registerView({ section, detail });
  }, [section, detail]);
}

function registerView(v: PageViewInfo): () => void {
  const key = `v${++seq}`;
  viewStore.set(key, [v]);
  return () => viewStore.remove(key);
}

const NO_VIEW: PageViewInfo[] = [];
/** The latest registered view (the innermost component wins). */
export function usePageViewInfo(): PageViewInfo | null {
  const all = useSyncExternalStore(viewStore.subscribe, viewStore.get, () => NO_VIEW);
  return all.length ? all[all.length - 1] : null;
}
