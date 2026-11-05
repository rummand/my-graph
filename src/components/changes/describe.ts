/** Each change as a sentence a person can read, with what it says now and after (pure; server and client). */
import type { TFn } from "@/lib/i18n/core";
import { fieldText, valueText } from "@/components/history/pure";

export type ReviewNode = { label: string; type: string; kind: string | null; summary: string | null; startAt: string | null; endAt: string | null; visibility: string; props: Record<string, unknown> };
export type ReviewEdge = { fromId: string; toId: string; relation: string; status: string; confidence: number };
export type DescribeCtx = {
  nodes: Record<string, ReviewNode>;
  edges: Record<string, ReviewEdge>;
  relations: Record<string, string>;
  kinds: Record<string, string>;
  /** Labels of nodes added by this same proposal. */
  added: Record<string, string>;
  formatDate: (iso: string) => string;
};
export type DescribedChange = { sentence: string; rows: { field: string; before: string; after: string }[] };

type Change = { op: string; nodeId: string | null; edgeId: string | null; payload: Record<string, unknown>; summary: string };

const s = (x: unknown) => (typeof x === "string" ? x : "");

function shown(v: unknown, t: TFn, ctx: DescribeCtx): string {
  if (typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v)) return ctx.formatDate(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const parts = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined && x !== "").map(([k, x]) => `${k.replace(/_/g, " ")}: ${valueText(x, t)}`);
    return parts.length ? parts.join(", ") : t("changes.nothing");
  }
  const out = valueText(v, t);
  return out === t("history.empty_value") ? t("changes.nothing") : out;
}

export function nameOf(id: unknown, ctx: DescribeCtx): string {
  if (typeof id !== "string") return "…";
  return ctx.nodes[id]?.label ?? ctx.added[id] ?? "…";
}

function relationText(key: string, ctx: DescribeCtx, t: TFn): string {
  return ctx.relations[key] ?? (key ? key.replace(/_/g, " ") : t("changes.nothing"));
}

function edgeName(id: string | null, ctx: DescribeCtx, t: TFn, fallback: string): string {
  const e = id ? ctx.edges[id] : undefined;
  if (!e) return fallback;
  return `${nameOf(e.fromId, ctx)} · ${relationText(e.relation, ctx, t)} · ${nameOf(e.toId, ctx)}`;
}

function statusText(v: unknown, t: TFn): string {
  return typeof v === "string" && ["confirmed", "unconfirmed", "inferred", "rejected", "superseded"].includes(v) ? t(`changes.status_.${v}`) : valueText(v, t);
}

export function describeChange(c: Change, ctx: DescribeCtx, t: TFn): DescribedChange {
  const p = c.payload;
  const rows: DescribedChange["rows"] = [];
  const typeWord = (type: string) => t(`changes.type.${type}`, undefined, "").trim();
  switch (c.op) {
    case "addNode": {
      const type = s(p.type) || "thing";
      const kind = s(p.kind) ? ctx.kinds[`${type}:${s(p.kind)}`] ?? s(p.kind).replace(/_/g, " ") : "";
      const sentence = kind ? t("changes.sentence.addNodeKind", { label: s(p.label), kind: kind.toLowerCase() })
        : t("changes.sentence.addNode", { type: typeWord(type), label: s(p.label) }).replace(/\s+/g, " ");
      if (s(p.summary)) rows.push({ field: fieldText("summary", t), before: t("changes.nothing"), after: s(p.summary) });
      if (s(p.startAt)) rows.push({ field: fieldText("startAt", t), before: t("changes.nothing"), after: shown(p.startAt, t, ctx) });
      for (const [k, v] of Object.entries((p.props as Record<string, unknown>) ?? {})) {
        if (v === null || v === undefined || v === "" || typeof v === "object") continue;
        rows.push({ field: fieldText(`props.${k}`, t), before: t("changes.nothing"), after: shown(v, t, ctx) });
      }
      return { sentence, rows };
    }
    case "updateNode": {
      const n = c.nodeId ? ctx.nodes[c.nodeId] : undefined;
      const set = (p.set as Record<string, unknown>) ?? {};
      for (const [k, v] of Object.entries(set)) {
        if (k === "props" && v && typeof v === "object") {
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
            rows.push({ field: fieldText(`props.${pk}`, t), before: shown(n?.props?.[pk], t, ctx), after: shown(pv, t, ctx) });
          }
          continue;
        }
        const before = n ? (n as unknown as Record<string, unknown>)[k] : undefined;
        rows.push({ field: fieldText(k, t), before: shown(before, t, ctx), after: k === "kind" && typeof v === "string" && n ? ctx.kinds[`${n.type}:${v}`] ?? v : shown(v, t, ctx) });
      }
      return { sentence: t("changes.sentence.updateNode", { name: nameOf(c.nodeId, ctx) }), rows };
    }
    case "retireNode":
      return { sentence: t("changes.sentence.retireNode", { name: nameOf(c.nodeId, ctx) }), rows };
    case "mergeNodes":
      return { sentence: t("changes.sentence.mergeNodes", { drop: nameOf(p.dropId, ctx), keep: nameOf(p.keepId, ctx) }), rows };
    case "addEdge": {
      if (p.status) rows.push({ field: fieldText("status", t), before: t("changes.nothing"), after: statusText(p.status, t) });
      if (s(p.relation).startsWith("role:")) {
        // "Lars holds the role doctor at Lægehuset Vejle" / "… doctor for Emma" / "… doctor" (where isn't known yet).
        const words = relationText(s(p.relation), ctx, t).split(/\s+/);
        const prep = words.length > 1 ? words.pop()! : "";
        const role = words.join(" ");
        const to = s(p.toId) ? ctx.nodes[s(p.toId)] : undefined;
        if (p.fromId === p.toId) return { sentence: t("changes.sentence.holdsRole", { name: nameOf(p.fromId, ctx), role }), rows };
        if (to?.type === "person") return { sentence: t("changes.sentence.holdsRoleFor", { name: nameOf(p.fromId, ctx), role, to: nameOf(p.toId, ctx) }), rows };
        return { sentence: t("changes.sentence.holdsRoleAt", { name: nameOf(p.fromId, ctx), role, prep, to: nameOf(p.toId, ctx) }), rows };
      }
      return { sentence: t("changes.sentence.addEdge", { from: nameOf(p.fromId, ctx), to: nameOf(p.toId, ctx), relation: relationText(s(p.relation), ctx, t) }), rows };
    }
    case "updateEdge": {
      const e = c.edgeId ? ctx.edges[c.edgeId] : undefined;
      for (const [k, v] of Object.entries((p.set as Record<string, unknown>) ?? {})) {
        const before = e ? (e as unknown as Record<string, unknown>)[k] : undefined;
        const fmt = (x: unknown) => (k === "status" ? statusText(x, t) : k === "relation" ? relationText(s(x), ctx, t) : k === "confidence" && typeof x === "number" ? `${Math.round(x * 100)}%` : shown(x, t, ctx));
        rows.push({ field: fieldText(k, t), before: fmt(before), after: fmt(v) });
      }
      return { sentence: t("changes.sentence.updateEdge", { name: edgeName(c.edgeId, ctx, t, c.summary) }), rows };
    }
    case "removeEdge":
      return { sentence: t("changes.sentence.removeEdge", { name: edgeName(c.edgeId, ctx, t, c.summary) }), rows };
    case "addKind":
      return { sentence: t("changes.sentence.addKind", { type: t(`changes.typePlain.${s(p.nodeType) || "thing"}`), label: s(p.label) }), rows };
    case "addRelationType": {
      const inverse = s(p.inverseLabel);
      return { sentence: inverse && inverse !== s(p.label) ? t("changes.sentence.addRelationTypeBoth", { label: s(p.label), inverse }) : t("changes.sentence.addRelationType", { label: s(p.label) }), rows };
    }
    case "addRole":
      return { sentence: t("changes.sentence.addRole", { label: s(p.label) }), rows };
    case "addAttribute":
      return { sentence: t("changes.sentence.addAttribute", { type: t(`changes.typePlain.${s(p.nodeType) || "thing"}`), label: s(p.label) }), rows };
    case "addReminder": {
      if (s(p.aboutNodeId)) rows.push({ field: t("history.page.about"), before: "", after: nameOf(p.aboutNodeId, ctx) });
      return { sentence: t("changes.sentence.addReminder", { date: s(p.dueAt) ? ctx.formatDate(s(p.dueAt)) : "…", title: s(p.title) }), rows };
    }
    case "editWiki": {
      const text = s(p.markdown);
      if (text) rows.push({ field: "", before: "", after: text.length > 240 ? `${text.slice(0, 239)}…` : text });
      return { sentence: t("changes.sentence.editWiki", { title: s(p.title) || s(p.slug) }), rows };
    }
    default:
      return { sentence: t("changes.sentence.other", { op: c.op }), rows };
  }
}
