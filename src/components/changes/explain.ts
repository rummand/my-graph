/**
 * Why a change can or can't be delivered, in plain words (pure; server and client). One sentence per op for its row,
 * and a title and explanation per group for the panel at the top of a proposal. The words come from the reason codes
 * and details the API returns; nothing here decides anything.
 */
import type { OpVerdict, ReasonGroup } from "@/lib/changes";
import type { TFn } from "@/lib/i18n/core";
import { dayKey } from "@/lib/i18n/dates";
import { fieldText, valueText } from "@/components/history/pure";

export type ExplainCtx = {
  t: TFn;
  formatDate: (iso: string) => string;
  timeZone?: string;
  now?: Date;
  /** Kind labels by `type:key`. */
  kinds: Record<string, string>;
  /** A node's name, from the graph or the proposal. */
  nameOf?: (id: string) => string;
};

type Change = { id: string; op: string; payload: Record<string, unknown>; summary: string };

/** "earlier today", "yesterday", "on 3 Nov 2026" in the reader's zone; "" when unknown. */
export function whenText(iso: string | null | undefined, ctx: ExplainCtx): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = ctx.now ?? new Date();
  const key = dayKey(d, ctx.timeZone);
  if (key === dayKey(now, ctx.timeZone)) return ctx.t("changes.when.today");
  if (key === dayKey(new Date(now.getTime() - 86_400_000), ctx.timeZone)) return ctx.t("changes.when.yesterday");
  return ctx.t("changes.when.on", { date: ctx.formatDate(iso) });
}

export function kindText(type: string, kind: string | null | undefined, ctx: ExplainCtx): string {
  if (!kind) return ctx.t(`changes.typePlain.${type || "thing"}`, undefined, type);
  return (ctx.kinds[`${type}:${kind}`] ?? kind.replace(/_/g, " ")).toLowerCase();
}

const when = (iso: string | null | undefined, ctx: ExplainCtx) => {
  const w = whenText(iso, ctx);
  return w ? ctx.t("changes.reason.whenPrefix", { when: w }) : "";
};
const by = (name: string | null | undefined, ctx: ExplainCtx) => (name ? ctx.t("changes.reason.byName", { name }) : "");
const label = (c: Change) => (typeof c.payload.label === "string" ? c.payload.label : c.summary);

/** The sentence for one op's own reason (null when there is nothing to say: it is simply to do). */
export function reasonText(r: OpVerdict | undefined, c: Change, ctx: ExplainCtx): string | null {
  if (!r) return null;
  const { t } = ctx;
  const d = r.details ?? {};
  const name = d.target?.label ?? c.summary;
  switch (r.code) {
    case "exists": {
      const e = d.existing!;
      return e.via === "chosen" ? t("changes.reason.existsChosen", { name: e.label }) : t("changes.reason.exists", { name: e.label });
    }
    case "to_add": return d.resolution?.asNew ? t("changes.reason.addedAsNew") : null;
    case "already_true": return t("changes.reason.landed");
    case "kept_graph": return t("changes.reason.keptGraph");
    case "to_change": return d.resolution?.keep === "proposal" ? t("changes.reason.usingProposal") : pointed(r, c, ctx);
    case "ambiguous_existing": return t("changes.reason.ambiguous_existing", { label: label(c) });
    case "kind_mismatch": {
      const other = d.candidates?.[0];
      const proposed = typeof c.payload.kind === "string" ? kindText(String(c.payload.type ?? "thing"), c.payload.kind, ctx) : "";
      return other?.kind && proposed
        ? t("changes.reason.kind_mismatch", { label: other.label, kind: kindText(other.type, other.kind, ctx), proposed })
        : t("changes.reason.kind_mismatchPlain", { label: other?.label ?? label(c) });
    }
    case "target_merged":
      return d.mergedInto
        ? t("changes.reason.target_merged", { name, into: d.mergedInto.label, when: when(d.at, ctx), by: by(d.by, ctx) })
        : t("changes.reason.target_mergedPlain", { name });
    case "target_retired": return t("changes.reason.target_retired", { name, when: when(d.at, ctx), by: by(d.by, ctx) });
    case "target_missing": return t("changes.reason.target_missing", { when: when(d.at, ctx), by: by(d.by, ctx) });
    case "value_changed":
      return d.by ? t("changes.reason.value_changed", { by: d.by, when: when(d.at, ctx) }) : t("changes.reason.value_changedPlain");
    case "depends_on_left_out": return t("changes.reason.depends_on_left_out", { label: d.dependsOn?.label ?? "…" });
    case "no_permission": return t("changes.reason.no_permission");
    case "different_types": return t("changes.reason.different_types");
    default: return pointed(r, c, ctx);
  }
}

/** An op pointed at other nodes says where: the item a merged one became, or the existing one a new one turned out to be. */
function pointed(r: OpVerdict, _c: Change, ctx: ExplainCtx): string | null {
  const remap = r.details?.remap;
  if (!remap || !Object.keys(remap).length) return null;
  const nameOf = ctx.nameOf ?? (() => "…");
  const [from, to] = Object.entries(remap)[0];
  if (r.details?.resolution?.follow) return ctx.t("changes.reason.pointedAt", { into: nameOf(to), name: nameOf(from) });
  return ctx.t("changes.reason.usesExisting", { name: [...new Set(Object.values(remap))].map(nameOf).join(", ") });
}

/** Where an existing thing came from, as a short line for its row ("Added from “X” earlier today."). */
export function originText(r: OpVerdict | undefined, ctx: ExplainCtx): string | null {
  const o = r?.details?.existing?.origin;
  if (!o) return null;
  const w = whenText(o.at, ctx);
  if (o.sourceTitle) return ctx.t("changes.reason.existsFrom", { source: o.sourceTitle, when: w }).replace(/\s+\./, ".");
  if (o.changeSetTitle) return ctx.t("changes.reason.existsFromSet", { set: o.changeSetTitle, when: w }).replace(/\s+\./, ".");
  if (o.by) return ctx.t("changes.reason.existsBy", { name: o.by, when: w }).replace(/\s+\./, ".");
  return null;
}

/** value_changed: each field as "The graph now: X / The proposal: Y". */
export function changedFields(r: OpVerdict | undefined, ctx: ExplainCtx): { field: string; now: string; proposed: string }[] {
  return (r?.details?.fields ?? []).map((f) => ({
    field: fieldText(f.field, ctx.t),
    now: valueText(f.now, ctx.t),
    proposed: valueText(f.proposed, ctx.t),
  }));
}

export type GroupText = { title: string; body: string[]; link?: { href: string; label: string } };

/** A group in the panel: what happened, why, and where to look. */
export function groupText(g: ReasonGroup, ctx: ExplainCtx): GroupText {
  const { t } = ctx;
  const count = g.changeIds.length;
  switch (g.code) {
    case "exists": {
      const o = g.origin;
      const w = whenText(o?.at, ctx);
      const body: string[] = [];
      if (o?.sourceTitle) body.push(t("changes.group.exists.fromSource", { count, source: o.sourceTitle, when: w }));
      else if (o?.changeSetTitle) body.push(t("changes.group.exists.fromSet", { count, set: o.changeSetTitle, when: w }));
      else if (o?.by) body.push(t("changes.group.exists.byPerson", { count, name: o.by, when: w }));
      else body.push(t("changes.group.exists.plain", { count }));
      body.push(t("changes.group.exists.then", { count }));
      if (g.leftOut) body.push(t("changes.group.exists.leftOut", { count: g.leftOut }));
      const link = o?.changeSetId ? { href: `/changes/${o.changeSetId}`, label: t("changes.group.exists.openSet") }
        : o?.sourceId ? { href: `/library/${o.sourceId}`, label: t("changes.group.exists.openSource") } : undefined;
      return { title: t("changes.group.exists.title", { count }), body: body.map((b) => b.replace(/\s+\./g, ".")), link };
    }
    case "target_merged":
      return {
        title: g.mergedInto ? t("changes.group.target_merged.title", { count, name: g.mergedInto.label }) : t("changes.group.target_merged.titlePlain", { count }),
        body: [t("changes.group.target_merged.body")],
        link: g.mergedInto ? { href: `/node/${g.mergedInto.id}`, label: g.mergedInto.label } : undefined,
      };
    default:
      return { title: t(`changes.group.${g.code}.title`, { count }), body: [t(`changes.group.${g.code}.body`)] };
  }
}
