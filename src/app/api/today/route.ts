import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { listSuggestions } from "@/lib/automations";
import { canUseAssistantTools } from "@/lib/automations/policy";
import { cachedBriefFor, listReminders } from "@/lib/briefs";
import { alwaysAllowLabel, canWriteInGraph, suggestionKindLabel, suggestionOriginLabel, suggestionPreview } from "@/lib/briefs/assistant-home";
import { addDaysInZone, formatLongDate, greetingFor, startOfDayInZone } from "@/lib/briefs/dates";
import { loadAttentionFacts, loadFailedUploads } from "@/lib/briefs/queries";
import { listChangeSets } from "@/lib/changes";
import { query, route } from "@/lib/changes/http";
import { connectionsNeedingYou } from "@/lib/connectors";
import * as gbrain from "@/lib/gbrain";
import { getPrefs, tFor } from "@/lib/i18n";
import { listSources } from "@/lib/ingest/library";
import { loadTimeline } from "@/lib/timeline";
import { attentionTotal, firstNameOf, groupWeek } from "./shape";

export const dynamic = "force-dynamic";

const q = z.object({
  /** How many days "This week" covers, today included. */
  days: z.coerce.number().int().min(1).max(14).optional(),
});

async function safe<T>(name: string, failed: string[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[api/today] ${name} failed:`, err);
    failed.push(name);
    return null;
  }
}

/**
 * GET /api/today?days=7 → everything the phone's Today screen shows, in one request, in the reader's language:
 * greeting, brief, the week by person, open to-dos, suggestions and proposed changes waiting for a decision,
 * recently added documents, connections that need the person, and what needs attention.
 * Each part loads on its own: a part that fails is null and named in `failed`, the rest still arrives.
 */
export const GET = route(async (req, v: Viewer) => {
  const { days = 7 } = query(req, q);
  const { locale, timeZone: tz } = await getPrefs();
  const t = tFor(locale);
  const now = new Date();
  const from = startOfDayInZone(now, tz);
  const weekEnd = addDaysInZone(from, days, tz);
  const inFamily = v.graphKind === "family";
  const assistantOn = canUseAssistantTools(v);
  const failed: string[] = [];

  const [reminders, timeline, suggestions, changeSets, recent, connections, attention, failedUploads, duplicates] = await Promise.all([
    safe("reminders", failed, () => listReminders(v, { upcoming: true, days: 14, limit: 50, now })),
    safe("week", failed, () => loadTimeline(v, { from: from.toISOString(), to: weekEnd.toISOString(), types: ["event"] })),
    assistantOn ? safe("suggestions", failed, () => listSuggestions(v, { status: "pending", limit: 10 })) : Promise.resolve([]),
    safe("changeSets", failed, () => listChangeSets(v, { status: "draft", limit: 10 })),
    safe("recent", failed, () => listSources(v, { limit: 5 })),
    safe("connections", failed, () => connectionsNeedingYou(v)),
    safe("attention", failed, () => loadAttentionFacts(v, { now, limit: 5 })),
    safe("failedUploads", failed, () => loadFailedUploads(v)),
    safe("duplicates", failed, () => gbrain.mergeSuggestions(v, 20).then((s) => s.length)),
  ]);

  const people = (timeline?.people ?? []).filter((p) => p.id !== "family").map((p) => ({ id: p.id, label: p.label, kind: p.kind }));
  const everyoneLabel = inFamily ? t("today.lane.family") : t("today.lane.everything");
  const graphKind = v.graphKind ?? "other";

  return Response.json({
    generatedAt: now.toISOString(),
    locale, timeZone: tz,
    greeting: {
      text: t("today.greetingName", { greeting: greetingFor(now, tz, locale), name: firstNameOf(v.name) }),
      date: formatLongDate(now, tz, locale),
    },
    me: { id: v.id, name: v.name, personNodeId: v.personNodeId, role: v.role },
    graph: { id: v.graphId, name: v.graphName, kind: v.graphKind, role: v.graphRole },
    canWrite: canWriteInGraph(v),
    assistantEnabled: assistantOn,
    brief: cachedBriefFor(v, now, { locale, tz }),
    reminders,
    week: timeline ? { items: timeline.items, people, from: from.toISOString(), to: weekEnd.toISOString() } : null,
    weekByPerson: timeline || reminders
      ? groupWeek({ items: timeline?.items ?? [], reminders: reminders ?? [], people, end: weekEnd, everyoneLabel })
      : null,
    everyoneLabel,
    suggestions: suggestions?.map((s) => ({
      ...s,
      kindLabel: suggestionKindLabel(s.kind, locale, graphKind),
      originLabel: suggestionOriginLabel({ origin: s.origin, createdAt: new Date(s.createdAt) }, now, tz, locale),
      alwaysLabel: alwaysAllowLabel(s.kind, locale, graphKind) ?? null,
      preview: suggestionPreview({ body: s.payload && Object.keys(s.payload).length ? null : s.body, payload: s.payload ?? {} }, tz, locale),
    })) ?? null,
    changeSets,
    recent: recent?.items ?? null,
    connections,
    attention: {
      facts: attention?.facts.map((f) => ({ edgeId: f.edgeId, nodeId: f.fromId, text: f.text, confidence: f.confidence, sourceId: f.sourceId, sourceTitle: f.sourceTitle })) ?? [],
      factTotal: attention?.total ?? null,
      failedUploads: failedUploads?.total ?? null,
      duplicates: duplicates ?? null,
      total: attentionTotal({ facts: attention?.total ?? null, failedUploads: failedUploads?.total ?? null, duplicates }),
    },
    failed,
  }, { headers: { "cache-control": "private, no-store" } });
});
