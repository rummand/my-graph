/**
 * What a signed or confirmed clinical item becomes in the practice graph, as change-set ops (pure). Proposed,
 * dismissed and open items produce no ops: nothing reaches the graph without the clinician's sign-off.
 */
import type { ChangeInput, Receipt } from "@/lib/changes";
import { isSignedOff, type Discipline } from "./pure";

export type OpsItem = { kind: string; status: string; content: Record<string, unknown>; title: string | null; measuredAt?: Date | null; value?: number | null; unit?: string | null; refLow?: number | null; refHigh?: number | null };
export type OpsContext = {
  clientNodeId: string; clientLabel: string; sessionNodeId: string | null; discipline: Discipline;
  receipt?: Receipt; signedBy?: string; signedAt?: Date; mint?: () => string;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function signOffOps(item: OpsItem, ctx: OpsContext): ChangeInput[] {
  if (!isSignedOff(item.status)) return [];
  const mint = ctx.mint ?? (() => globalThis.crypto.randomUUID());
  const receipt = ctx.receipt ?? {};
  const c = item.content ?? {};
  const linked = (node: { type: string; kind: string; label: string; props?: Record<string, unknown>; startAt?: string | null }, relation: string): ChangeInput[] => {
    const nodeId = mint();
    return [
      { op: "addNode", nodeId, type: node.type, kind: node.kind, label: node.label.slice(0, 200), props: node.props ?? {}, startAt: node.startAt ?? null, visibility: "private", receipt },
      { op: "addEdge", fromId: ctx.clientNodeId, toId: nodeId, relation, status: "confirmed", receipt },
    ];
  };
  switch (item.kind) {
    case "note": {
      if (!ctx.sessionNodeId) return [];
      const text = str(c.text);
      return [{
        op: "updateNode", nodeId: ctx.sessionNodeId, receipt,
        set: { summary: text.slice(0, 280), props: { note: text, noteSignedAt: (ctx.signedAt ?? new Date()).toISOString(), noteSignedBy: ctx.signedBy ?? null } },
        note: "Signed note",
      }];
    }
    case "letter": {
      if (str(c.letterKind) !== "referral") return [];
      const to = str(c.recipient) || "referral";
      return linked({ type: "event", kind: "referral", label: `Referral to ${to}`, props: { recipient: to }, startAt: (ctx.signedAt ?? new Date()).toISOString() }, "referred_to");
    }
    case "code": {
      const code = str(c.code), system = str(c.system);
      if (!code) return [];
      return linked({ type: "topic", kind: "diagnosis", label: `${code} ${str(c.label)}`.trim(), props: { code, code_system: system } }, "diagnosed_with");
    }
    case "medication": {
      const name = str(c.name);
      if (!name) return [];
      return linked({ type: "thing", kind: "medication", label: name, props: { dose: str(c.dose) || null, frequency: str(c.frequency) || null } }, "takes");
    }
    case "allergy": {
      const substance = str(c.substance);
      if (!substance) return [];
      return linked({ type: "thing", kind: "allergen", label: substance, props: { reaction: str(c.reaction) || null } }, "allergic_to");
    }
    case "lab": {
      const name = str(c.name) || item.title || "";
      if (!name || item.value == null) return [];
      const range = item.refLow != null || item.refHigh != null ? `${item.refLow ?? ""}–${item.refHigh ?? ""}` : null;
      return linked({
        type: "event", kind: "lab_result", label: `${name} ${item.value}${item.unit ? ` ${item.unit}` : ""}`,
        props: { value: item.value, unit: item.unit ?? null, reference_range: range }, startAt: (item.measuredAt ?? new Date()).toISOString(),
      }, "has_result");
    }
    case "measure": {
      const label = str(c.label) || item.title || "Measure";
      if (item.value == null) return [];
      return linked({ type: "event", kind: "measure", label: `${label}: ${item.value}`, props: { instrument: label, score: item.value }, startAt: (item.measuredAt ?? new Date()).toISOString() }, "has_result");
    }
    default:
      // Themes, hypotheses, summaries and follow-ups stay in the clinical record (follow-ups are not household
      // reminders: in a practice graph other editors could read a reminder's title).
      return [];
  }
}
