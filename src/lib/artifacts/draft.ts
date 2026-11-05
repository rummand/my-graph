/**
 * Drafting an artifact (server-only): graph-scoped retrieval with the viewer's own access (GBrain filters every
 * read), then mux route `smart` writes structured content citing the evidence. Sensitive evidence keeps the call on
 * local models. When mux is down, a plain draft is laid out from the same evidence.
 */
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { getMeta } from "@/lib/meta";
import * as mux from "@/lib/mux";
import { tFor, formatDate, type Locale } from "@/lib/i18n";
import type { ArtifactKind } from "@/lib/design-sets/tokens";
import type { ArtifactContent, Citation, Section } from "./content";
import { draftMessages, fallbackDraft, fromModelDraft, modelDraftSchema, type Evidence, type SourceQuery } from "./draft-pure";

const MAX_EVIDENCE = 48;

type Locator = { page?: number; timeStartSec?: number } | null | undefined;
function locatorText(l: Locator): string | null {
  if (!l) return null;
  if (typeof l.page === "number") return `p. ${l.page}`;
  if (typeof l.timeStartSec === "number") {
    const s = Math.floor(l.timeStartSec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return null;
}

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function nodeText(n: gbrain.GNode): string {
  const props = Object.entries(n.props ?? {})
    .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== "" && ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 8).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  return clip([n.summary ?? "", props.join("; ")].filter(Boolean).join(" — ") || n.label, 600);
}

/** Everything the draft may draw on, as numbered evidence. */
export async function gatherEvidence(v: Viewer, q: SourceQuery, fallbackQuery: string): Promise<{ evidence: Evidence[]; sensitive: boolean }> {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  let sensitive = false;
  const push = (e: Omit<Evidence, "key">, dedupe: string) => {
    if (seen.has(dedupe) || out.length >= MAX_EVIDENCE) return;
    seen.add(dedupe);
    out.push({ ...e, key: `E${out.length + 1}` });
  };
  const addNode = (n: gbrain.GNode) => {
    if (n.sensitive) sensitive = true;
    push({
      kind: "node", nodeType: n.type, nodeId: n.id, when: n.startAt, text: nodeText(n),
      citation: { kind: "node", nodeId: n.id, label: n.label, quote: null, locator: null },
    }, `node:${n.id}`);
  };
  const safe = async <T>(p: Promise<T>, d: T): Promise<T> => { try { return await p; } catch (e) { console.error("[artifacts] retrieval:", e); return d; } };
  const meta = await safe(getMeta(v), null);
  const rel = (key: string) => meta?.relationLabel(key, "out") ?? key.replace(/_/g, " ");

  for (const a of (q.about ?? []).slice(0, 6)) {
    const node = await safe(gbrain.getNode(v, a.nodeId), null);
    if (!node) continue;
    addNode(node);
    const [hood, provs] = await Promise.all([
      safe(gbrain.neighbourhood(v, node.id, 1), { nodes: [], edges: [] }),
      safe(gbrain.explain(v, { type: "node", id: node.id }), []),
    ]);
    const label = new Map(hood.nodes.map((n) => [n.id, n.label]));
    label.set(node.id, node.label);
    for (const p of provs.slice(0, 4)) {
      if (!p.sourceId || !p.quote) continue;
      push({
        kind: "source", text: clip(p.quote, 500),
        citation: { kind: "source", sourceId: p.sourceId, nodeId: node.id, label: p.sourceTitle ?? node.label, quote: clip(p.quote, 500), locator: locatorText(p.locator as Locator) },
      }, `prov:${p.id}`);
    }
    for (const e of hood.edges.slice(0, 24)) {
      const from = label.get(e.fromId), to = label.get(e.toId);
      if (!from || !to) continue;
      push({
        kind: "edge", ends: [from, to], text: `${from} ${rel(e.relation)} ${to}${e.status === "inferred" ? " (inferred, not confirmed)" : ""}`,
        citation: { kind: "edge", edgeId: e.id, nodeId: e.fromId === node.id ? e.toId : e.fromId, label: `${from} · ${to}`, quote: null, locator: null },
      }, `edge:${e.id}`);
    }
    for (const n of hood.nodes.slice(0, 20)) if (n.id !== node.id) addNode(n);
  }

  if (q.from || q.to) {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(`${q.to}T23:59:59Z`) : undefined;
    const ids = (q.about ?? []).map((a) => a.nodeId);
    const tl = await safe(gbrain.timeline(v, { from, to, personIds: ids.length ? ids : undefined, limit: 30 }), { events: [], involves: [] });
    for (const ev of tl.events) addNode(ev);
  }

  const question = (q.question ?? "").trim() || (out.length ? "" : fallbackQuery);
  if (question) {
    const hits = await safe(gbrain.search(v, question, { limit: 14 }), []);
    for (const h of hits) {
      if (h.kind === "node" && h.node) addNode(h.node);
      else if (h.kind === "chunk" && h.chunk) {
        push({
          kind: "source", text: clip(h.chunk.text, 700),
          citation: { kind: "source", sourceId: h.chunk.sourceId, chunkId: h.chunk.id, label: h.chunk.sourceTitle, quote: clip(h.chunk.text, 400), locator: locatorText(h.chunk.locator as Locator) },
        }, `chunk:${h.chunk.id}`);
      }
    }
  }
  return { evidence: out, sensitive };
}

function fallbackLabels(locale: Locale) {
  const t = tFor(locale);
  return {
    overview: t("artifacts.fallback.overview"), facts: t("artifacts.fallback.facts"), people: t("artifacts.fallback.people"),
    timeline: t("artifacts.fallback.timeline"), sources: t("artifacts.fallback.sources"), nothing: t("artifacts.fallback.nothing"),
  };
}

export type DraftResult = { title: string | null; content: ArtifactContent; model: string | null; usedModel: boolean; sensitive: boolean; message: string | null };

/** Draft a whole artifact. Never throws for mux trouble: falls back to a plain layout. */
export async function draftArtifact(v: Viewer, input: { kind: ArtifactKind; title: string; query: SourceQuery; tone: string; locale: Locale; timeZone: string; artifactId?: string }): Promise<DraftResult> {
  const { evidence, sensitive } = await gatherEvidence(v, input.query, input.title);
  const fmt = (d: Date) => formatDate(d, "date", { locale: input.locale, timeZone: input.timeZone });
  const t = tFor(input.locale);
  if (!evidence.length) {
    return { title: null, content: fallbackDraft([], input.kind, fallbackLabels(input.locale), fmt), model: null, usedModel: false, sensitive, message: t("artifacts.draft.noEvidence") };
  }
  try {
    const draft = await mux.completeJson({
      route: "smart",
      maxTokens: 4000,
      messages: draftMessages({ kind: input.kind, title: input.title, query: input.query, evidence, tone: input.tone, language: input.locale === "da" ? "da" : "en" }),
      parse: (x) => modelDraftSchema.parse(x),
      // affinity = the artifact: its draft and later section redrafts stay on one model (shared instructions cached).
      meta: { userId: v.id, agent: "my-graph-artifacts", graphId: v.graphId, sensitive, affinity: input.artifactId ? `artifact:${input.artifactId}` : undefined },
    });
    const { title, content } = fromModelDraft(draft, evidence);
    return { title, content, model: null, usedModel: true, sensitive, message: null };
  } catch (e) {
    const down = mux.isMuxDown(e);
    if (!down) console.error("[artifacts] draft failed:", e);
    return {
      title: null, content: fallbackDraft(evidence, input.kind, fallbackLabels(input.locale), fmt), model: null, usedModel: false, sensitive,
      message: down ? t("artifacts.draft.muxDown") : t("artifacts.draft.modelFailed"),
    };
  }
}

/** Redraft one section. Throws when mux can't do it (the person keeps the section they have). */
export async function draftSection(v: Viewer, input: {
  kind: ArtifactKind; title: string; query: SourceQuery; tone: string; locale: Locale; section: Section; currentText: string; instruction?: string; artifactId?: string;
}): Promise<{ section: Section; citations: Citation[] }> {
  const query: SourceQuery = { ...input.query, question: [input.query.question, input.section.title, input.instruction].filter(Boolean).join(" — ") };
  const { evidence, sensitive } = await gatherEvidence(v, query, input.section.title || input.title);
  const draft = await mux.completeJson({
    route: "smart",
    maxTokens: 2000,
    messages: draftMessages({
      kind: input.kind, title: input.title, query, evidence, tone: input.tone, language: input.locale === "da" ? "da" : "en",
      section: { title: input.section.title, current: input.currentText, instruction: input.instruction },
    }),
    parse: (x) => modelDraftSchema.parse(x),
    meta: { userId: v.id, agent: "my-graph-artifacts", graphId: v.graphId, sensitive, affinity: input.artifactId ? `artifact:${input.artifactId}` : undefined },
  });
  const { content } = fromModelDraft(draft, evidence, { idPrefix: "n" });
  const first = content.sections[0];
  if (!first) throw new mux.MuxError(502, "bad_response", "The assistant sent an empty section.", null);
  return { section: { ...first, id: input.section.id, title: first.title || input.section.title }, citations: content.citations };
}
