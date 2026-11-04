/**
 * What a calendar event becomes in the graph, as proposed changes (pure). A new event is an `addNode` (type event,
 * with a node id minted up front and kept on the source, so a later change to the same UID updates that node instead
 * of making a second one) plus an `involves` edge to the person whose calendar it is. A changed event is an
 * `updateNode` when its node exists, else the `addNode` again with the same id. A cancelled event proposes retiring it.
 * Every op carries a receipt pointing at the event's own source.
 */
import type { ChangeInput } from "@/lib/changes";
import type { IcsEvent } from "./parse";

export type EventOpInput = {
  event: IcsEvent;
  action: "add" | "update" | "cancel";
  sourceId: string;
  nodeId: string;
  /** The node for this event already exists in the graph (a person delivered it). */
  nodeExists: boolean;
  personNodeId?: string | null;
  visibility: "private" | "parents" | "household";
  calendarName: string | null;
  connectionLabel: string;
};

function summaryOf(e: IcsEvent): string | undefined {
  const parts = [e.location ? `At ${e.location}.` : "", e.description ? e.description.replace(/\s+/g, " ").slice(0, 400) : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function propsOf(e: IcsEvent, calendarName: string | null): Record<string, unknown> {
  return {
    ...(e.location ? { location: e.location } : {}),
    ...(e.allDay ? { allDay: true, date: e.date } : {}),
    ...(e.status === "tentative" ? { tentative: true } : {}),
    ...(e.url ? { url: e.url } : {}),
    ...(calendarName ? { calendar: calendarName } : {}),
    icsUid: e.uid,
  };
}

export function eventOps(i: EventOpInput): ChangeInput[] {
  const { event: e } = i;
  const receipt = { sourceId: i.sourceId, quote: e.summary + (e.location ? `, ${e.location}` : ""), ...(e.url ? { url: e.url } : {}), confidence: 1 };
  const from = `From ${i.connectionLabel}`;
  if (i.action === "cancel") {
    return i.nodeExists ? [{ op: "retireNode", nodeId: i.nodeId, note: `${from}: this was cancelled in the calendar.`, receipt }] : [];
  }
  if (i.action === "update" && i.nodeExists) {
    return [{
      op: "updateNode", nodeId: i.nodeId,
      set: { label: e.summary, startAt: e.start.toISOString(), endAt: e.end?.toISOString() ?? null, summary: summaryOf(e) ?? null, props: propsOf(e, i.calendarName) },
      note: `${from}: the calendar changed this.`, receipt,
    }];
  }
  const edge: ChangeInput[] = i.personNodeId
    ? [{ op: "addEdge", fromId: i.nodeId, toId: i.personNodeId, relation: "involves", status: "unconfirmed", confidence: 0.9, note: `It's in their calendar (${i.connectionLabel}).`, receipt }]
    : [];
  // Already in the graph from someone else's calendar: only say whose calendar it is in too.
  if (i.action === "add" && i.nodeExists) return edge;
  const ops: ChangeInput[] = [{
    op: "addNode", nodeId: i.nodeId, type: "event", label: e.summary, summary: summaryOf(e), props: propsOf(e, i.calendarName),
    startAt: e.start.toISOString(), endAt: e.end?.toISOString() ?? null, visibility: i.visibility,
    note: i.action === "update" ? `${from}: the calendar changed this.` : `${from}.`, receipt,
  }];
  return [...ops, ...edge];
}

/** "3 new dates and 1 change from Aula calendar" (English; the change set title is data, shown as written). */
export function proposalTitle(counts: { add: number; update: number; cancel: number }, label: string): string {
  const parts: string[] = [];
  if (counts.add) parts.push(`${counts.add} new ${counts.add === 1 ? "date" : "dates"}`);
  if (counts.update) parts.push(`${counts.update} ${counts.update === 1 ? "change" : "changes"}`);
  if (counts.cancel) parts.push(`${counts.cancel} ${counts.cancel === 1 ? "cancellation" : "cancellations"}`);
  return `${parts.join(", ") || "Calendar updates"} from ${label}`;
}
