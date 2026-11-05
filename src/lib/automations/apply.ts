/**
 * Applying an approved suggestion (server-only). Each kind goes through the library that owns that data, as the
 * person deciding, so access is checked again at decision time (the graph, their role, the items' visibility):
 *   reminder  → briefs createReminder
 *   fact      → gbrain: confirm an existing edge, or add one (provenance: the assistant's inference + the person's approval)
 *   merge     → gbrain mergeNodes
 *   memory    → memory addMemory, then active (a person approved it)
 *   rule      → memory addMemory (kind "rule"), then active
 *   wiki_edit → wiki: append to the page, or create it
 *   nudge     → acknowledged, nothing written
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { voiceOf } from "@/lib/assistant/locale";
import * as gbrain from "@/lib/gbrain";
import { createReminder, ReminderInputError } from "@/lib/briefs";
import { addMemory, updateMemory, type MemoryOrigin } from "@/lib/memory";
import { createPage, getPage, updatePage, PageError } from "@/lib/pages";
import type { Suggestion } from "./index";
import {
  factPayload, memoryPayload, mergePayload, nudgePayload, reminderPayload, safeInternalHref, wikiEditPayload,
} from "./policy";
import { AutomationError } from "./store";
import { paragraphsDoc } from "./apply-doc";
import { deliverChangeSet, proposeChanges, type ChangeInput, type ChangeSetOrigin } from "@/lib/changes";

/**
 * Facts, merges and wiki edits become a change set (with the suggestion's evidence as receipts) that the approving
 * person delivers at once: the approval is their decision, and the change lands in the graph's history with the
 * proposal it came from. Null when versioning is unavailable (the caller then applies directly, as before).
 */
async function viaChangeSet(v: Viewer, s: Suggestion, ops: ChangeInput[]): Promise<{ id: string } | null> {
  const origin: ChangeSetOrigin = s.origin;
  const firstCitation = s.citations.find((c) => c.sourceId);
  const proposed = await proposeChanges(v, {
    title: s.title.slice(0, 200) || "Approved suggestion", description: s.body ?? undefined, origin,
    evidence: { sourceId: firstCitation?.sourceId ?? undefined, quote: firstCitation?.quote ?? undefined, conversationId: s.conversationId ?? undefined, runId: s.runId ?? undefined },
    changes: ops,
  }).catch((e) => { console.error("[automations] propose", e); return null; });
  if (!proposed) return null;
  const d = await deliverChangeSet(v, proposed.id, {});
  if (!d.ok) throw new AutomationError(409, d.error ?? "This no longer fits the graph as it is now.");
  if (d.error) throw new AutomationError(422, d.error);
  return { id: proposed.id };
}

export type ApplyResult = { href?: string; label: string };

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const r = schema.safeParse(payload);
  if (!r.success) throw new AutomationError(422, "This suggestion is missing details, so it can't be applied. Deny it and ask again.");
  return r.data;
}

const MEMORY_ORIGIN: Record<Suggestion["origin"], MemoryOrigin> = { chat: "chat", automation: "automation", heartbeat: "automation", ingest: "upload" };

function modelAgent(s: Suggestion, p?: { agentId?: string }): string {
  return p?.agentId ?? `assistant:${s.origin}`;
}

export async function applySuggestion(v: Viewer, s: Suggestion): Promise<ApplyResult> {
  try {
    return await applyInner(v, s);
  } catch (e) {
    if (e instanceof AutomationError) throw e;
    if (e instanceof gbrain.GBrainError) throw new AutomationError(e.status === 409 ? 409 : e.status === 400 ? 422 : e.status, e.message);
    if (e instanceof PageError) throw new AutomationError(e.status === 413 ? 422 : e.status, e.message);
    if (e instanceof ReminderInputError) throw new AutomationError(422, e.message);
    throw e;
  }
}

async function applyInner(v: Viewer, s: Suggestion): Promise<ApplyResult> {
  switch (s.kind) {
    case "nudge": {
      const p = parse(nudgePayload, s.payload);
      const href = safeInternalHref(p.href);
      return { href, label: p.label ?? "Noted." };
    }
    case "reminder": {
      const p = parse(reminderPayload, s.payload);
      const r = await createReminder(v, { title: p.title, detail: p.detail ?? null, dueAt: new Date(p.dueAt), aboutNodeId: p.aboutNodeId ?? null });
      return { href: "/", label: `Reminder added: ${r.title}` };
    }
    case "merge": {
      const p = parse(mergePayload, s.payload);
      if (await viaChangeSet(v, s, [{ op: "mergeNodes", keepId: p.keepId, dropId: p.dropId, note: s.body ?? undefined }])) {
        const kept = await gbrain.getNode(v, p.keepId);
        return { href: `/node/${p.keepId}`, label: `Merged into ${kept?.label ?? "the kept item"}` };
      }
      const kept = await gbrain.mergeNodes(v, p.keepId, p.dropId);
      return { href: `/node/${kept.id}`, label: `Merged into ${kept.label}` };
    }
    case "fact": {
      const p = parse(factPayload, s.payload);
      if ("edgeId" in p && await viaChangeSet(v, s, [{ op: "updateEdge", edgeId: p.edgeId, set: { status: "confirmed", confidence: 1 }, note: "Confirmed from the assistant's suggestion" }])) {
        return { href: "/graph", label: "Fact confirmed" };
      }
      if ("edgeId" in p) {
        const e = await gbrain.setEdgeStatus(v, p.edgeId, "confirmed", "Confirmed from the assistant's suggestion");
        return { href: `/node/${e.fromId}`, label: "Fact confirmed" };
      }
      const firstCitation = s.citations.find((c) => c.sourceId);
      const sourceId = p.sourceId ?? firstCitation?.sourceId ?? null;
      const prov: gbrain.ProvenanceInput = {
        sourceId, quote: p.quote ?? firstCitation?.quote ?? null, activity: "inference", agentType: "model", agentId: modelAgent(s, p),
        confidence: p.confidence ?? 0.6, note: `Suggested by the assistant (${s.origin}) and approved by ${v.name}.`,
      };
      const end = async (id: string | undefined, ref: { label: string; type: "person" | "place" | "event" | "topic" } | undefined) => {
        if (id) {
          const n = await gbrain.getNode(v, id);
          if (!n) throw new AutomationError(404, "Something this fact is about is no longer visible to you.");
          return n;
        }
        return (await gbrain.upsertNode(v, { type: ref!.type, label: ref!.label }, prov)).node;
      };
      // As a change set: known ends by id; a new end is resolved against the graph first, else added with a minted id.
      const ops: ChangeInput[] = [];
      const receipt = { sourceId: sourceId ?? undefined, quote: prov.quote ?? undefined, confidence: prov.confidence, conversationId: s.conversationId ?? undefined, runId: s.runId ?? undefined };
      const endId = async (id: string | undefined, ref: { label: string; type: "person" | "place" | "event" | "topic" } | undefined) => {
        if (id) return (await gbrain.getNode(v, id))?.id ?? null;
        const found = (await gbrain.listNodes(v, { type: ref!.type, q: ref!.label, limit: 10 })).find((n) => n.label.trim().toLowerCase() === ref!.label.trim().toLowerCase());
        if (found) return found.id;
        const nodeId = randomUUID();
        ops.push({ op: "addNode", nodeId, type: ref!.type, label: ref!.label, receipt });
        return nodeId;
      };
      const fromId = await endId(p.fromId, p.from), toId = await endId(p.toId, p.to);
      if (!fromId || !toId) throw new AutomationError(404, "Something this fact is about is no longer visible to you.");
      ops.push({ op: "addEdge", fromId, toId, relation: p.relation, status: "confirmed", confidence: prov.confidence, note: s.body ?? undefined, receipt });
      if (await viaChangeSet(v, s, ops)) {
        const [a, b] = await Promise.all([gbrain.getNode(v, fromId), gbrain.getNode(v, toId)]);
        return { href: `/node/${fromId}`, label: `Added: ${a?.label ?? ""} ${p.relation.replace(/_/g, " ")} ${b?.label ?? ""}` };
      }
      const from = await end(p.fromId, p.from);
      const to = await end(p.toId, p.to);
      const edge = await gbrain.addEdge(v, { fromId: from.id, toId: to.id, relation: p.relation, status: "inferred", confidence: prov.confidence }, prov);
      // A person approved it: record that as their confirmation (a second provenance row), never a silent promotion.
      await gbrain.setEdgeStatus(v, edge.id, "confirmed", "Approved from the assistant's suggestion");
      return { href: `/node/${from.id}`, label: `Added: ${from.label} ${p.relation.replace(/_/g, " ")} ${to.label}` };
    }
    case "memory":
    case "rule": {
      const p = parse(memoryPayload, s.payload);
      const kind = s.kind === "rule" ? "rule" : p.kind ?? "note";
      const m = await addMemory(v, {
        kind, text: p.text, aboutNodeIds: p.aboutNodeIds, origin: MEMORY_ORIGIN[s.origin], createdByKind: "assistant",
        conversationId: p.conversationId ?? s.conversationId ?? undefined, messageId: p.messageId ?? undefined,
        sourceId: p.sourceId ?? s.citations.find((c) => c.sourceId)?.sourceId, runId: s.runId ?? undefined,
        quote: p.quote ?? undefined, visibility: p.visibility,
      });
      if (!m) throw new AutomationError(503, "Memory isn't available yet, so this couldn't be saved. It stays in your inbox.");
      if (m.status !== "active") await updateMemory(v, m.id, { status: "active" });
      const { t, family } = await voiceOf(v);
      return { href: "/memory", label: kind === "rule" ? t(family ? "automations.server.applied.ruleFamily" : "automations.server.applied.rule", { text: m.text }) : t("automations.server.applied.remembered", { text: m.text }) };
    }
    case "wiki_edit": {
      const p = parse(wikiEditPayload, s.payload);
      if (await viaChangeSet(v, s, [{ op: "editWiki", slug: p.slug ?? "", title: p.title, markdown: p.text, ...(p.visibility ? { visibility: p.visibility } : {}) } as ChangeInput])) {
        const page = p.slug ? await getPage(v, p.slug) : null;
        return { href: page ? `/artifacts/pages/${page.slug}` : "/artifacts/pages", label: page ? `Added to ${page.title}` : `Page created: ${p.title}` };
      }
      const blocks = paragraphsDoc(p.text);
      if (p.slug) {
        const page = await getPage(v, p.slug);
        if (page) {
          const content = { ...page.content, content: [...(page.content.content ?? []), ...blocks] };
          const r = await updatePage(v, page.slug, { version: page.version, content });
          return { href: `/artifacts/pages/${r.page.slug}`, label: `Added to ${r.page.title}` };
        }
      }
      const page = await createPage(v, { title: p.title, visibility: p.visibility ?? "private", content: { type: "doc", content: blocks } });
      return { href: `/artifacts/pages/${page.slug}`, label: `Page created: ${page.title}` };
    }
  }
}
