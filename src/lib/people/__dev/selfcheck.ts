/* Dev self-check against the real DB: npx tsx src/lib/people/__dev/selfcheck.ts  (creates and removes a test household) */
import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { households, provenance, users, auditLog } from "@/db/schema";
import { ensureBuiltins, getMeta } from "@/lib/meta";
import { upsertKind, hideBuiltin } from "@/lib/meta/admin";
import type { Viewer } from "@/lib/auth";
import { viewerFor } from "@/lib/graphs/store";
import { addObservation, addRelation, createPerson, peopleContext, peopleOverview, personProfile, updatePerson } from "@/lib/people";

async function main() {
  console.log("ensureBuiltins", await ensureBuiltins({ force: true }));
  console.log("ensureBuiltins again", await ensureBuiltins({ force: true }));
  const [hh] = await db.insert(households).values({ name: "People selfcheck" }).returning();
  try {
    const [pu] = await db.insert(users).values({ householdId: hh.id, email: `p-${hh.id}@x.test`, name: "Anna", role: "parent" }).returning();
    const [cu] = await db.insert(users).values({ householdId: hh.id, email: `c-${hh.id}@x.test`, name: "Emma", role: "child" }).returning();
    const parent: Viewer = await viewerFor({ id: pu.id, householdId: hh.id, name: "Anna", email: pu.email, role: "parent" as const, personNodeId: null as string | null });
    const child: Viewer = await viewerFor({ id: cu.id, householdId: hh.id, name: "Emma", email: cu.email, role: "child" as const, personNodeId: null as string | null });

    const me = await createPerson(parent, { label: "Anna", kind: "parent", visibility: "household" });
    await db.update(users).set({ personNodeId: me.id }).where(eq(users.id, pu.id));
    parent.personNodeId = me.id;
    const emma = await createPerson(parent, { label: "Emma", kind: "child", props: { birthday: "2017-11-05", allergies: "Nuts" }, relation: { key: "parent_of", direction: "in", otherId: me.id } });
    await db.update(users).set({ personNodeId: emma.id }).where(eq(users.id, cu.id));
    child.personNodeId = emma.id;
    const mette = await createPerson(parent, { label: "Mette Lærer", kind: "teacher", relation: { key: "teacher_of", direction: "out", otherId: emma.id } });
    const mormor = await createPerson(parent, { label: "Mormor", kind: "grandparent", props: { birthday: "1950-11-10" }, relation: { key: "grandparent_of", direction: "out", otherId: me.id } });
    const ida = await addRelation(parent, emma.id, { relation: "friend_of", direction: "out", newPerson: { label: "Ida", kind: "childs_friend" } });
    console.log("created", { me, emma, mette, mormor, ida });

    await addObservation(parent, emma.id, { kind: "wellbeing", score: 4, note: "Happy at school", at: new Date(Date.now() - 6 * 86400e3) });
    await addObservation(parent, emma.id, { kind: "wellbeing", score: 2, note: "Tired, fell out with Ida", tags: ["school", "friends"] });
    await addObservation(parent, mormor.id, { kind: "contact", tags: ["talked"], at: new Date(Date.now() - 20 * 86400e3) });

    try { await updatePerson(parent, emma.id, { props: { birthday: "not a date" } }); console.log("!! expected validation error"); }
    catch (e) { console.log("validation ok:", (e as Error).message, JSON.stringify((e as { details?: unknown }).details)); }
    await updatePerson(parent, emma.id, { props: { shoe_size: "32", class: "3.B" } });

    // household override + hide
    await upsertKind(hh.id, { nodeType: "person", key: "teacher", label: "Lærer", circle: "school" });
    await hideBuiltin(hh.id, "kinds", { nodeType: "person", key: "manager" });
    const meta = await getMeta(parent);
    console.log("teacher label:", meta.kind("person", "teacher")?.label, "manager hidden:", meta.kind("person", "manager")?.hidden, "visible person kinds:", meta.kindsFor("person").length);

    const o = await peopleOverview(parent);
    console.log("center", o.center, "centers", o.centers.map((c) => c.label));
    for (const p of o.people) console.log(" ", p.label, "|", p.kind, p.circle, "|", p.relation?.label, "| last", p.lastContactAt?.slice(0, 10), "| wb", p.wellbeing.map((w) => w.score), "| bday", p.nextBirthday);
    console.log("attention", o.attention);
    const oc = await peopleOverview(parent, { centerId: emma.id });
    console.log("centered on Emma:", oc.people.map((p) => `${p.label}: ${p.relation?.label ?? "-"}`));

    const prof = await personProfile(parent, emma.id);
    console.log("profile attrs", prof?.attributes.map((a) => a.key).join(","), "props", prof?.person.props);
    console.log("relationships", prof?.relationships.map((g) => `${g.label}: ${g.items.map((i) => `${i.label} ${i.other.label}`).join("; ")}`));
    console.log("feed", prof?.feed.map((f) => f.title), "canEdit", prof?.person.canEdit, "prov", prof?.provenance);

    const asChild = await personProfile(child, emma.id);
    console.log("child sees attrs", asChild?.attributes.map((a) => a.key).join(","), "observations", asChild?.observations.length);
    const childOverview = await peopleOverview(child);
    console.log("child overview", childOverview.people.map((p) => `${p.label}: ${p.relation?.label ?? "-"}`));

    console.log("--- context ---\n" + (await peopleContext(parent, [])));
    console.log("--- context emma ---\n" + (await peopleContext(parent, [emma.id])));
  } finally {
    await db.delete(provenance).where(eq(provenance.householdId, hh.id));
    await db.delete(auditLog).where(eq(auditLog.householdId, hh.id));
    await db.delete(households).where(eq(households.id, hh.id));
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
