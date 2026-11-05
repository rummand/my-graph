/**
 * Demo commitments for Anna's Family graph (development only). Adds a few believable letters and messages to her
 * library (a car insurance renewal from Tryg, an Aula consent for Noah's swimming, a library reminder, a message from
 * Karen about her ladder, Birgit's thank-you for theatre tickets) and PROPOSES one commitment from each, with the
 * passage it rests on — plus Emma's passport and Noah's SFO fee. Nothing is delivered: Anna delivers them on
 * /changes or /commitments like any proposal. Idempotent (re-running adds nothing twice).
 *
 *   npx tsx scripts/seed-commitments.ts [--email anna@example.com]
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
process.env.DISABLE_SCHEDULER ??= "1";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

/** 2026-11-16 23:59 in Copenhagen (CET, UTC+1 in winter). */
const cph = (day: string, time = "23:59") => new Date(`${day}T${time}:00+01:00`).toISOString();

type Doc = { key: string; title: string; kind: "email" | "manual" | "connector"; date: string; text: string; visibility: "household" | "parents" };

const DOCS: Doc[] = [
  {
    key: "tryg", kind: "email", date: "2026-11-02", visibility: "parents", title: "Tryg: Din bilforsikring fornyes 1. januar",
    text: "Fra: Tryg <kundeservice@tryg.dk>\nEmne: Din bilforsikring fornyes 1. januar 2027\n\nKære Anna Jensen\n\nDin bilforsikring (police 4471-220-913) fornyes automatisk den 1. januar 2027. Den nye årlige pris er 6.840 kr.\nØnsker du at opsige forsikringen, skal det ske skriftligt senest 16. november 2026.\n\nVenlig hilsen\nTryg Forsikring",
  },
  {
    key: "swim", kind: "connector", date: "2026-11-03", visibility: "household", title: "Aula: Svømmeundervisning i 1.A",
    text: "Kære forældre i 1.A\n\nFra uge 47 har klassen svømmeundervisning i Bellahøj Svømmehal om tirsdagen. Giv samtykke i Aula senest mandag den 9. november, så Noah og de andre kan komme med.\n\nMvh. Karen Hansen, klasselærer",
  },
  {
    key: "library", kind: "email", date: "2026-11-04", visibility: "household", title: "Lindholm Bibliotek: Påmindelse om aflevering",
    text: "Fra: Lindholm Bibliotek <laan@lindholmbib.dk>\nEmne: Påmindelse: Aflevering af lån\n\nKære Anna Jensen\n\nFølgende materialer skulle have været afleveret den 3. november 2026:\n- Pippi Langstrømpe\n- Alfons Åberg\n\nDer pålægges et gebyr på 5 kr. pr. dag pr. materiale fra 10. november.\n\nVenlig hilsen\nLindholm Bibliotek",
  },
  {
    key: "ladder", kind: "manual", date: "2026-11-04", visibility: "household", title: "Beskeder med Karen Holm",
    text: "Karen Holm: Hej Mikkel, har I stadig min stige? Jeg skal bruge den lørdag.\nMikkel: Ja! Jeg kommer forbi med den fredag 👍",
  },
  {
    key: "theatre", kind: "manual", date: "2026-10-29", visibility: "household", title: "Besked fra Birgit Jensen",
    text: "Birgit Jensen: Tusind tak for billetterne til Folketeatret, det var en dejlig aften! Jeg overfører de 450 kr., når jeg har fået løn.",
  },
];

async function main() {
  const { and, eq, sql } = await import("drizzle-orm");
  const { db, sql: pg } = await import("@/db");
  const { chunks, graphs, graphMembers, nodes, sources, users, changeSets } = await import("@/db/schema");
  const { viewerFor } = await import("@/lib/auth/viewer-for");
  const { proposeChanges } = await import("@/lib/changes");
  const { commitmentOps } = await import("@/lib/commitments/ops");
  const { commitmentFingerprint } = await import("@/lib/commitments/detect/fingerprint");

  const email = arg("--email") ?? "anna@example.com";
  const [anna] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!anna) throw new Error(`No user ${email}.`);
  const [fam] = await db.select({ id: graphs.id }).from(graphs).innerJoin(graphMembers, eq(graphMembers.graphId, graphs.id))
    .where(and(eq(graphMembers.userId, anna.id), eq(graphs.kind, "family"))).limit(1);
  if (!fam) throw new Error(`${email} has no family graph.`);
  const v = await viewerFor(anna.id, fam.id);
  if (!v) throw new Error("Could not act as Anna in her family graph.");

  // People and places already in the demo graph, by name.
  const byName = async (label: string, type: "person" | "organization" | "place") => {
    const [n] = await db.select({ id: nodes.id }).from(nodes)
      .where(and(eq(nodes.graphId, fam.id), eq(nodes.type, type), sql`lower(${nodes.label}) = lower(${label})`, sql`${nodes.mergedInto} is null`)).limit(1);
    return n?.id ?? null;
  };
  const ids = {
    anna: v.personNodeId ?? (await byName("Anna", "person")),
    mikkel: await byName("Mikkel", "person"), emma: await byName("Emma", "person"), noah: await byName("Noah", "person"),
    karenHansen: await byName("Ms. Karen Hansen", "person"), karenHolm: await byName("Karen Holm", "person"), birgit: await byName("Birgit Jensen", "person"),
    library: await byName("Lindholm Library", "organization"),
  };
  const need = (x: string | null) => (x ? [x] : []);

  // The letters and messages, as library sources with one passage each (no reading pipeline: the proposals below are
  // what reading them would propose, so nothing is proposed twice).
  const doc: Record<string, { sourceId: string; chunkId: string; text: string; title: string }> = {};
  for (const d of DOCS) {
    const [have] = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.graphId, fam.id), sql`${sources.meta}->>'demo' = ${`commitments:${d.key}`}`)).limit(1);
    let sourceId = have?.id;
    if (!sourceId) {
      const [s] = await db.insert(sources).values({
        householdId: v.graphHouseholdId, graphId: fam.id, ownerId: anna.id, kind: d.kind, title: d.title, mime: "text/plain", textContent: d.text,
        status: "ready", visibility: d.visibility, documentDate: new Date(`${d.date}T09:00:00+01:00`), meta: { demo: `commitments:${d.key}` }, size: d.text.length,
      }).returning({ id: sources.id });
      sourceId = s.id;
      await db.insert(chunks).values({ sourceId, graphId: fam.id, ownerId: anna.id, idx: 0, text: d.text, locator: { charStart: 0, charEnd: d.text.length } });
    }
    const [c] = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.sourceId, sourceId)).limit(1);
    doc[d.key] = { sourceId, chunkId: c.id, text: d.text, title: d.title };
  }
  const receipt = (key: string, quote: string, confidence = 0.85) => {
    const d = doc[key];
    const at = d.text.indexOf(quote);
    if (at < 0) throw new Error(`The quote isn't in ${key}: ${quote}`);
    return { sourceId: d.sourceId, chunkId: d.chunkId, quote, locator: { charStart: at, charEnd: at + quote.length }, confidence };
  };

  const proposals: { key: string; title: string; origin: "ingest" | "person"; draft: Parameters<typeof commitmentOps>[0] }[] = [
    {
      key: "tryg", title: `From “${doc.tryg.title}”`, origin: "ingest",
      draft: {
        label: "Give notice on the car insurance with Tryg, if we want to switch", direction: "owe", kind: "notice", dueAt: cph("2026-11-16"),
        recurrence: "FREQ=YEARLY", amount: { value: 6840, currency: "DKK" }, consequence: "It renews for another year at 6,840 kr.",
        responsibleIds: need(ids.anna), newCounterparty: { label: "Tryg Forsikring", type: "organization" }, visibility: "parents",
        fingerprint: commitmentFingerprint({ kind: "notice", counterparty: "Tryg", about: "bilforsikring", dueDay: "2026-11-16" }),
        receipt: receipt("tryg", "Ønsker du at opsige forsikringen, skal det ske skriftligt senest 16. november 2026."),
        note: "Tryg's letter gives the last day to cancel before the car insurance renews.",
      },
    },
    {
      key: "swim", title: `From “${doc.swim.title}”`, origin: "ingest",
      draft: {
        label: "Give consent in Aula for Noah's swimming lessons", direction: "owe", kind: "form", dueAt: cph("2026-11-09", "12:00"),
        responsibleIds: need(ids.mikkel), withIds: need(ids.karenHansen), aboutIds: need(ids.noah),
        consequence: "Noah can't join the swimming lessons from week 47.",
        fingerprint: commitmentFingerprint({ kind: "form", counterparty: "Karen Hansen", about: "Noah", dueDay: "2026-11-09" }),
        receipt: receipt("swim", "Giv samtykke i Aula senest mandag den 9. november"),
      },
    },
    {
      key: "library", title: `From “${doc.library.title}”`, origin: "ingest",
      draft: {
        label: "Return Emma's two library books to Lindholm Library", direction: "owe", kind: "return", dueAt: cph("2026-11-03"),
        responsibleIds: need(ids.anna), withIds: need(ids.library), aboutIds: need(ids.emma),
        consequence: "A fine of 5 kr a day per book from 10 November.",
        fingerprint: commitmentFingerprint({ kind: "return", counterparty: "Lindholm Library", about: "Emma", dueDay: "2026-11-03" }),
        receipt: receipt("library", "Følgende materialer skulle have været afleveret den 3. november 2026"),
      },
    },
    {
      key: "ladder", title: `From “${doc.ladder.title}”`, origin: "ingest",
      draft: {
        label: "Give Karen her ladder back", direction: "promise", kind: "return", dueAt: cph("2026-11-06", "17:00"), dueKind: "approx",
        responsibleIds: need(ids.mikkel), withIds: need(ids.karenHolm),
        fingerprint: commitmentFingerprint({ kind: "return", counterparty: "Karen Holm", about: "stige", dueDay: "2026-11-06" }),
        receipt: receipt("ladder", "Ja! Jeg kommer forbi med den fredag", 0.75),
      },
    },
    {
      key: "theatre", title: `From “${doc.theatre.title}”`, origin: "ingest",
      draft: {
        label: "Birgit pays back 450 kr for the theatre tickets", direction: "owed", kind: "payment", dueAt: null, amount: { value: 450, currency: "DKK" },
        responsibleIds: need(ids.anna), withIds: need(ids.birgit),
        fingerprint: commitmentFingerprint({ kind: "payment", counterparty: "Birgit Jensen", about: "teaterbilletter", dueDay: null }),
        receipt: receipt("theatre", "Jeg overfører de 450 kr., når jeg har fået løn.", 0.7),
      },
    },
    {
      key: "passport", title: "Emma's passport", origin: "person",
      draft: {
        label: "Renew Emma's passport before the Easter trip", direction: "owe", kind: "renewal", dueAt: cph("2027-02-15", "12:00"),
        responsibleIds: need(ids.anna), aboutIds: need(ids.emma), newCounterparty: { label: "Borgerservice Vejle", type: "organization" },
        consequence: "Her passport runs out on 2 April 2027, before the trip.", receipt: { confidence: 1, locator: { note: "Written by Anna" } },
      },
    },
    {
      key: "sfo", title: "Noah's SFO fee", origin: "person",
      draft: {
        label: "Pay Noah's SFO fee for November", direction: "owe", kind: "payment", dueAt: cph("2026-11-01", "12:00"), recurrence: "FREQ=MONTHLY",
        amount: { value: 1935, currency: "DKK" }, responsibleIds: need(ids.mikkel), aboutIds: need(ids.noah),
        newCounterparty: { label: "Vejle Kommune", type: "organization" }, visibility: "parents", receipt: { confidence: 1, locator: { note: "Written by Anna" } },
      },
    },
  ];

  let made = 0;
  for (const p of proposals) {
    const [had] = await db.select({ id: changeSets.id }).from(changeSets)
      .where(and(eq(changeSets.graphId, fam.id), sql`${changeSets.evidence}->>'demo' = ${`commitments:${p.key}`}`)).limit(1);
    if (had) continue;
    const { ops } = commitmentOps(p.draft);
    const r = await proposeChanges(v, {
      title: p.title, origin: p.origin, changes: ops,
      evidence: { ...(p.draft.receipt ?? {}), demo: `commitments:${p.key}` } as never,
    });
    if (r) { made++; console.log(`proposed ${p.key}: /changes/${r.id}`); }
  }
  console.log(made ? `${made} proposals waiting for ${anna.name} on /changes.` : "Nothing new: the demo commitments are already proposed.");
  await pg.end({ timeout: 5 });
}

main().catch((e) => { console.error(e); process.exit(1); });
