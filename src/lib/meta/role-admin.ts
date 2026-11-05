/**
 * A person's own edits to the roles of their household's model (people who decide about the model only — callers
 * check). Adding a role is a person's decision, written straight away and kept in the model's history; hiding a
 * built-in writes a tombstone (a household row with the key and builtin = true), showing it again removes that row.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { metaRoles } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { remembering } from "@/lib/changes";
import { ALL_CIRCLES, META_NODE_TYPES } from "./types";
import { ensureBuiltins } from "./index";

const keyRe = /^[a-z][a-z0-9_]{0,47}$/;
const hh = (v: Viewer) => v.graphHouseholdId ?? v.householdId;

export const roleInput = z.object({
  key: z.string().trim().toLowerCase().regex(keyRe, "Use lowercase letters, digits and _ (e.g. football_coach)").optional(),
  label: z.string().trim().min(1, "Give it a name").max(80),
  labelDa: z.string().trim().max(80).nullish(),
  pluralLabel: z.string().trim().max(80).nullish(),
  preposition: z.string().trim().min(1).max(20).default("of"),
  prepositionDa: z.string().trim().max(20).nullish(),
  circle: z.enum(ALL_CIRCLES as [string, ...string[]]).nullish(),
  contextTypes: z.array(z.enum(META_NODE_TYPES as [string, ...string[]])).max(6).default([]),
  description: z.string().trim().max(300).nullish(),
});

/** "Football coach" → "football_coach". */
export function roleKeyFrom(label: string): string {
  const k = label.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/æ/gi, "ae").replace(/ø/gi, "oe").replace(/å/gi, "aa")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9_]+/, "").slice(0, 48);
  return k || "role";
}

const recorded = <T>(v: Viewer, what: string, write: () => Promise<T>) => remembering(v, { actorKind: "person", actorName: v.name, context: `meta:${what}` }, write);

/** A new role for the household (or its override of a built-in's words). */
export async function saveRole(v: Viewer, input: z.infer<typeof roleInput>) {
  await ensureBuiltins();
  const key = input.key ?? roleKeyFrom(input.label);
  return recorded(v, "role", async () => {
    const values = {
      householdId: hh(v), graphId: null, key, label: input.label, labelDa: input.labelDa ?? null, pluralLabel: input.pluralLabel ?? null,
      preposition: input.preposition, prepositionDa: input.prepositionDa ?? null, circle: input.circle ?? null, contextTypes: input.contextTypes,
      description: input.description ?? null, builtin: false, status: "active", origin: "manual", sortOrder: 5000, firstSeenAt: new Date(),
    };
    const [row] = await db.insert(metaRoles).values(values)
      .onConflictDoUpdate({ target: [metaRoles.householdId, metaRoles.graphId, metaRoles.key], set: { ...values, householdId: undefined, firstSeenAt: undefined } as never })
      .returning();
    return row;
  });
}

/** Hide a role from pickers (a built-in gets a tombstone; the household's own is set hidden). Old facts still read. */
export async function hideRole(v: Viewer, key: string): Promise<boolean> {
  await ensureBuiltins();
  return recorded(v, "hide", async () => {
    const [own] = await db.select().from(metaRoles).where(and(eq(metaRoles.householdId, hh(v)), isNull(metaRoles.graphId), eq(metaRoles.key, key)));
    if (own) { await db.update(metaRoles).set(own.builtin ? {} : { status: "hidden" }).where(eq(metaRoles.id, own.id)); return true; }
    const [b] = await db.select().from(metaRoles).where(and(isNull(metaRoles.householdId), eq(metaRoles.key, key)));
    if (!b) return false;
    await db.insert(metaRoles).values({ householdId: hh(v), graphId: null, key, label: b.label, preposition: b.preposition, builtin: true, status: "active", origin: "manual" });
    return true;
  });
}

/** Show a hidden role again. */
export async function showRole(v: Viewer, key: string): Promise<boolean> {
  return recorded(v, "show", async () => {
    const [own] = await db.select().from(metaRoles).where(and(eq(metaRoles.householdId, hh(v)), isNull(metaRoles.graphId), eq(metaRoles.key, key)));
    if (!own) return false;
    if (own.builtin) await db.delete(metaRoles).where(eq(metaRoles.id, own.id));
    else await db.update(metaRoles).set({ status: "active" }).where(eq(metaRoles.id, own.id));
    return true;
  });
}
