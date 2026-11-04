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
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { createReminder, ReminderInputError } from "@/lib/briefs";
import { addMemory, updateMemory, type MemoryOrigin } from "@/lib/memory";
import { createPage, getPage, updatePage, WikiError } from "@/lib/wiki";
import type { Suggestion } from "./index";
import {
  factPayload, memoryPayload, mergePayload, nudgePayload, reminderPayload, safeInternalHref, wikiEditPayload,
} from "./policy";
import { AutomationError } from "./store";
import { paragraphsDoc } from "./apply-doc";

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
    if (e instanceof WikiError) throw new AutomationError(e.status === 413 ? 422 : e.status, e.message);
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
      const kept = await gbrain.mergeNodes(v, p.keepId, p.dropId);
      return { href: `/node/${kept.id}`, label: `Merged into ${kept.label}` };
    }
    case "fact": {
      const p = parse(factPayload, s.payload);
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
      return { href: "/memory", label: kind === "rule" ? `Family rule saved: ${m.text}` : `Remembered: ${m.text}` };
    }
    case "wiki_edit": {
      const p = parse(wikiEditPayload, s.payload);
      const blocks = paragraphsDoc(p.text);
      if (p.slug) {
        const page = await getPage(v, p.slug);
        if (page) {
          const content = { ...page.content, content: [...(page.content.content ?? []), ...blocks] };
          const r = await updatePage(v, page.slug, { version: page.version, content });
          return { href: `/wiki/${r.page.slug}`, label: `Added to ${r.page.title}` };
        }
      }
      const page = await createPage(v, { title: p.title, visibility: p.visibility ?? "private", content: { type: "doc", content: blocks } });
      return { href: `/wiki/${page.slug}`, label: `Page created: ${page.title}` };
    }
  }
}
