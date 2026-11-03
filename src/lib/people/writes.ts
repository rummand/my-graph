/**
 * People writes (server). Node/edge writes go through gbrain (provenance: manual_edit by the user); while gbrain's
 * stubs still throw "not implemented" we fall back to direct drizzle writes that record provenance the same way.
 * `nodes.kind` isn't in gbrain's NodeInput yet, so the kind is always set here (with its own provenance row).
 */
import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { edges, nodes, observations, provenance } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as auth from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import type { ProvenanceInput } from "@/lib/gbrain";
import { findRelation, getMeta, type Meta } from "@/lib/meta";
import type { PropError } from "@/lib/meta/types";
import { visibleNode, canEditNode } from "./data";
import type { ObservationKind, Visibility } from "./types";

export class PeopleError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

const VIS_ORDER: Visibility[] = ["private", "parents", "household"];
export const narrowest = (...vs: Visibility[]): Visibility => VIS_ORDER[Math.min(...vs.map((v) => VIS_ORDER.indexOf(v)))];

/** Default visibility for a new person: household for family / school / care, private otherwise. */
export function defaultVisibility(circle: string | null | undefined): Visibility {
  return circle === "family" || circle === "school" || circle === "care" ? "household" : "private";
}

const userProv = (v: Viewer, note?: string): ProvenanceInput => ({ activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note });

function notImplemented(e: unknown): boolean {
  return e instanceof Error && /not implemented/i.test(e.message);
}

async function viaGbrain<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try { return await primary(); } catch (e) { if (notImplemented(e)) return fallback(); throw e; }
}

async function safeAudit(v: Viewer, action: string, target: { type: string; id: string }, meta: Record<string, unknown> = {}) {
  try { await auth.audit(v, action, target, meta); } catch { /* audit not available yet */ }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function writeProv(tx: Tx | typeof db, v: Viewer, subjectType: "node" | "edge", subjectId: string, note?: string) {
  await tx.insert(provenance).values({ householdId: v.householdId, subjectType, subjectId, activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note });
}

/** Set nodes.kind directly (gbrain has no kind field yet), with provenance. No-op when unchanged. */
async function setKind(v: Viewer, id: string, kind: string | null, opts: { onlyIfEmpty?: boolean } = {}) {
  const [cur] = await db.select({ kind: nodes.kind }).from(nodes).where(eq(nodes.id, id));
  if (!cur || cur.kind === kind || (opts.onlyIfEmpty && cur.kind)) return;
  await db.transaction(async (tx) => {
    await tx.update(nodes).set({ kind, updatedAt: new Date() }).where(eq(nodes.id, id));
    await writeProv(tx, v, "node", id, `Kind set to ${kind ?? "none"}`);
  });
}

function propsOrThrow(meta: Meta, kind: string | null, props: Record<string, unknown>, partial: boolean) {
  const r = meta.validateProps("person", kind, props, { partial });
  if (!r.ok) throw new PeopleError(422, "Some details need fixing", { fields: r.errors satisfies PropError[] });
  // drop nulls on create; keep them on update so the caller can remove keys
  return r.value;
}

/* ── Nodes ────────────────────────────────────────────────────────────────────────────────────────────── */

export type CreatePersonInput = {
  label: string;
  kind: string | null;
  visibility?: Visibility;
  sensitive?: boolean;
  props?: Record<string, unknown>;
  /** Relation to an existing person: `direction: "out"` = new person is the from-side (new → other). */
  relation?: { key: string; direction: "out" | "in"; otherId: string } | null;
};

async function insertPersonDirect(v: Viewer, input: { label: string; props: Record<string, unknown>; visibility: Visibility; sensitive: boolean; kind: string | null }) {
  return db.transaction(async (tx) => {
    const [n] = await tx.insert(nodes).values({
      householdId: v.householdId, ownerId: v.id, type: "person", kind: input.kind, label: input.label, props: input.props,
      visibility: input.visibility, sensitive: input.sensitive,
    }).returning();
    await writeProv(tx, v, "node", n.id, "Added on the People page");
    return n.id;
  });
}

export async function createPerson(v: Viewer, input: CreatePersonInput): Promise<{ id: string; created: boolean; edgeId: string | null }> {
  if (v.role === "guest") throw new PeopleError(403, "Guests can't add people");
  const meta = await getMeta(v);
  const kind = input.kind ? meta.kind("person", input.kind) : undefined;
  if (input.kind && (!kind || kind.hidden)) throw new PeopleError(422, "Unknown kind of person", { fields: [{ key: "kind", message: "Pick a kind from the list" }] });
  const props = Object.fromEntries(Object.entries(propsOrThrow(meta, input.kind, input.props ?? {}, false)).filter(([, x]) => x !== null));
  const visibility = input.visibility ?? defaultVisibility(kind?.circle);
  const sensitive = input.sensitive ?? false;
  const label = input.label.trim();

  // Check the other end first so we don't create half a story.
  let other: Awaited<ReturnType<typeof visibleNode>> = null;
  if (input.relation) {
    other = await visibleNode(v, input.relation.otherId);
    if (!other) throw new PeopleError(404, "The other person isn't in your graph");
    if (!findRelation(meta.model, input.relation.key)) throw new PeopleError(422, "Unknown relation");
  }

  const { id, created } = await viaGbrain(
    async () => {
      const r = await gbrain.upsertNode(v, { type: "person", label, props, visibility, sensitive, ...({ kind: input.kind } as object) }, userProv(v, "Added on the People page"));
      return { id: r.node.id, created: r.created };
    },
    async () => ({ id: await insertPersonDirect(v, { label, props, visibility, sensitive, kind: input.kind }), created: true }),
  );
  // An existing match (entity resolution) keeps the kind it already has.
  await setKind(v, id, input.kind, { onlyIfEmpty: !created });

  let edgeId: string | null = null;
  if (input.relation && other) {
    const out = input.relation.direction === "out";
    edgeId = await addEdgeSafe(v, { fromId: out ? id : other.id, toId: out ? other.id : id, relation: input.relation.key, visibility: narrowest(visibility, other.visibility) });
  }
  await safeAudit(v, "people.create", { type: "node", id }, { kind: input.kind, created });
  return { id, created, edgeId };
}

export type UpdatePersonInput = { label?: string; kind?: string | null; visibility?: Visibility; sensitive?: boolean; props?: Record<string, unknown>; summary?: string | null; aliases?: string[] };

export async function updatePerson(v: Viewer, id: string, patch: UpdatePersonInput) {
  const node = await visibleNode(v, id);
  if (!node || node.type !== "person") throw new PeopleError(404, "Person not found");
  if (!(await canEditNode(v, node))) throw new PeopleError(403, "You can't edit this person");
  if (patch.visibility && patch.visibility !== node.visibility && node.ownerId !== v.id) throw new PeopleError(403, "Only the person who added them can change who sees them");
  if (patch.sensitive !== undefined && patch.sensitive !== node.sensitive && node.ownerId !== v.id) throw new PeopleError(403, "Only the person who added them can change whether they are sensitive");
  const meta = await getMeta(v);
  const kind = patch.kind !== undefined ? patch.kind : node.kind;
  if (patch.kind && !meta.kind("person", patch.kind)) throw new PeopleError(422, "Unknown kind of person", { fields: [{ key: "kind", message: "Pick a kind from the list" }] });

  let props: Record<string, unknown> | undefined;
  if (patch.props) {
    // Children can't touch sensitive attributes they can't see.
    if (v.role === "child" && node.ownerId !== v.id) {
      const sens = new Set(meta.attributesFor("person", kind).filter((a) => a.sensitive).map((a) => a.key));
      for (const k of Object.keys(patch.props)) if (sens.has(k)) throw new PeopleError(403, "You can't change that detail");
    }
    const checked = propsOrThrow(meta, kind, patch.props, true);
    // gbrain merges props, so a removed value is written as null (readers treat null as "not set").
    props = { ...checked };
  }
  const nodePatch = {
    ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
    ...(props ? { props } : {}),
    ...(patch.visibility ? { visibility: patch.visibility } : {}),
    ...(patch.sensitive !== undefined ? { sensitive: patch.sensitive } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary ?? undefined } : {}),
    ...(patch.aliases ? { aliases: patch.aliases } : {}),
  };
  if (Object.keys(nodePatch).length) {
    await viaGbrain(
      () => gbrain.updateNode(v, id, nodePatch, userProv(v, "Edited on the person's profile")).then(() => undefined),
      () => db.transaction(async (tx) => {
        await tx.update(nodes).set({ ...nodePatch, ...(props ? { props: { ...node.props, ...props } } : {}), summary: patch.summary !== undefined ? patch.summary : undefined, updatedAt: new Date() }).where(eq(nodes.id, id));
        await writeProv(tx, v, "node", id, `Edited: ${Object.keys(nodePatch).join(", ")}`);
      }),
    );
  }
  if (patch.kind !== undefined) await setKind(v, id, patch.kind);
  await safeAudit(v, "people.update", { type: "node", id }, { fields: Object.keys(patch) });
}

/* ── Edges ────────────────────────────────────────────────────────────────────────────────────────────── */

async function addEdgeSafe(v: Viewer, e: { fromId: string; toId: string; relation: string; visibility: Visibility }): Promise<string> {
  const meta = await getMeta(v);
  const symmetric = !!findRelation(meta.model, e.relation)?.symmetric;
  return viaGbrain(
    async () => (await gbrain.addEdge(v, { ...e, status: "confirmed", confidence: 1 }, userProv(v, "Added on the People page"))).id,
    async () => {
      const sameDir = and(eq(edges.fromId, e.fromId), eq(edges.toId, e.toId));
      const reverse = and(eq(edges.fromId, e.toId), eq(edges.toId, e.fromId));
      const [existing] = await db.select().from(edges).where(and(eq(edges.householdId, v.householdId), eq(edges.relation, e.relation), symmetric ? or(sameDir, reverse) : sameDir));
      return db.transaction(async (tx) => {
        if (existing && existing.status !== "rejected" && existing.status !== "superseded") {
          await tx.update(edges).set({ status: "confirmed", confidence: 1 }).where(eq(edges.id, existing.id));
          await writeProv(tx, v, "edge", existing.id, "Confirmed on the People page");
          return existing.id;
        }
        const [row] = await tx.insert(edges).values({ householdId: v.householdId, ownerId: v.id, ...e, status: "confirmed", confidence: 1 }).returning();
        await writeProv(tx, v, "edge", row.id, "Added on the People page");
        return row.id;
      });
    },
  );
}

export type AddRelationInput = {
  relation: string;
  /** "out": this person → other (this person is `label` of other); "in": other → this person. */
  direction: "out" | "in";
  otherId?: string;
  newPerson?: { label: string; kind: string | null; visibility?: Visibility };
};

export async function addRelation(v: Viewer, personId: string, input: AddRelationInput): Promise<{ edgeId: string; otherId: string }> {
  if (v.role === "guest") throw new PeopleError(403, "Guests can't add relationships");
  const person = await visibleNode(v, personId);
  if (!person || person.type !== "person") throw new PeopleError(404, "Person not found");
  const meta = await getMeta(v);
  const rel = findRelation(meta.model, input.relation);
  if (!rel || rel.hidden) throw new PeopleError(422, "Unknown relation");

  let otherId = input.otherId ?? null;
  if (!otherId && input.newPerson) {
    otherId = (await createPerson(v, { label: input.newPerson.label, kind: input.newPerson.kind, visibility: input.newPerson.visibility })).id;
  }
  if (!otherId) throw new PeopleError(422, "Pick someone or add a new person");
  if (otherId === personId) throw new PeopleError(422, "A person can't be related to themselves");
  const other = await visibleNode(v, otherId);
  if (!other) throw new PeopleError(404, "That person isn't in your graph");

  const from = input.direction === "out" ? person : other;
  const to = input.direction === "out" ? other : person;
  const fits = (types: string[], t: string) => types.length === 0 || types.includes(t);
  if (!fits(rel.fromTypes, from.type) || !fits(rel.toTypes, to.type)) {
    throw new PeopleError(422, `"${rel.label}" doesn't fit a ${from.type} and a ${to.type}`);
  }
  const edgeId = await addEdgeSafe(v, { fromId: from.id, toId: to.id, relation: rel.key, visibility: narrowest(person.visibility, other.visibility) });
  await safeAudit(v, "people.relate", { type: "edge", id: edgeId }, { relation: rel.key });
  return { edgeId, otherId };
}

/* ── Observations ─────────────────────────────────────────────────────────────────────────────────────── */

export type ObservationInput = {
  kind: ObservationKind;
  score?: number | null;
  note?: string | null;
  tags?: string[];
  at?: Date;
  visibility?: Visibility;
  sensitive?: boolean;
};

/** Default: check-ins and health notes are parents-only; contact and milestones follow the person. Never wider than the person. */
export function defaultObservationVisibility(kind: ObservationKind, personVisibility: Visibility): Visibility {
  const base: Visibility = kind === "wellbeing" || kind === "health" ? "parents" : "household";
  return narrowest(base, personVisibility);
}

export async function addObservation(v: Viewer, personId: string, input: ObservationInput) {
  if (v.role === "guest") throw new PeopleError(403, "Guests can't log check-ins");
  const person = await visibleNode(v, personId);
  if (!person || person.type !== "person") throw new PeopleError(404, "Person not found");
  if (input.kind === "wellbeing" && (input.score == null || input.score < 1 || input.score > 5)) throw new PeopleError(422, "Pick how they are, from 1 to 5");
  const at = input.at ?? new Date();
  if (at.getTime() > Date.now() + 5 * 60_000) throw new PeopleError(422, "Check-ins can't be in the future");
  // Never visible to more people than the person themself.
  const visibility = input.visibility ? narrowest(input.visibility, person.visibility) : defaultObservationVisibility(input.kind, person.visibility);
  const [row] = await db.insert(observations).values({
    householdId: v.householdId, ownerId: v.id, personNodeId: personId, kind: input.kind,
    score: input.kind === "wellbeing" ? input.score! : null, note: input.note?.trim() || null,
    tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12),
    at, authorKind: "user", visibility, sensitive: input.sensitive ?? (input.kind === "health" || person.sensitive),
  }).returning();
  await safeAudit(v, "people.observe", { type: "observation", id: row.id }, { kind: input.kind, personId });
  return row;
}
