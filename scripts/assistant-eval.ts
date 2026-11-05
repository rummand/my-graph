/**
 * Small, in-process evals for the assistant's cheaper paths (runs against the local database and mux; no dev server).
 *
 *   npx tsx scripts/assistant-eval.ts retrieval   [--json out.json]   10 questions → what retrieval hands the answer model
 *   npx tsx scripts/assistant-eval.ts highlights  [--json out.json]   10 sentences → what live highlights mark as new things
 *   npx tsx scripts/assistant-eval.ts compliance  [--json out.json]   a compliant and a non-compliant text against BEK 1081
 *   npx tsx scripts/assistant-eval.ts planner                          which of the token-report turns run the tool planner
 *   npx tsx scripts/assistant-eval.ts cache                            consecutive calls of the same job: cached tokens rise?
 *
 * Signs in as nobody: it builds the viewer for EVAL_EMAIL (default the demo account) in EVAL_GRAPH (default the graph
 * called "Family"). Reads only, except `compliance` (writes check runs, as the app does) and `highlights` (none).
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const cmd = args[0] ?? "retrieval";
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const JSON_OUT = arg("json");
const EMAIL = process.env.EVAL_EMAIL ?? "anna@example.com";
const GRAPH = process.env.EVAL_GRAPH ?? "Family";

async function viewer() {
  const { db } = await import("@/db");
  const { users, graphs, graphMembers } = await import("@/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { toViewer } = await import("@/lib/auth/store");
  const { withGraph } = await import("@/lib/auth");
  const [u] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  if (!u) throw new Error(`No user ${EMAIL}`);
  const [g] = await db.select({ id: graphs.id }).from(graphs).innerJoin(graphMembers, eq(graphMembers.graphId, graphs.id))
    .where(and(eq(graphMembers.userId, u.id), eq(graphs.name, GRAPH))).limit(1);
  const v = await withGraph(toViewer(u), g?.id ?? null);
  if (!v) throw new Error("No graph for the viewer");
  return v;
}

const out: Record<string, unknown> = { at: new Date().toISOString(), cmd };

/* ── Retrieval ─────────────────────────────────────────────────────────────────────────────────────────── */

const QUESTIONS: { q: string; expect: RegExp; avoid?: RegExp }[] = [
  { q: "When is Emma's swimming practice, and what does she need to bring?", expect: /sw[iø]m|svøm/i, avoid: /zoo|§|bekendtgørelse|advokat/i },
  { q: "Hvem er Noahs læge, og hvornår skal han til lægen næste gang?", expect: /læge|doctor|dr\.?/i, avoid: /zoo|advokat/i },
  { q: "Hvad skal Emma have med til svømning?", expect: /svøm|swim/i, avoid: /zoo|§|advokat/i },
  { q: "What do we know about Emma?", expect: /emma/i, avoid: /advokat/i },
  { q: "Hvilke regler gælder for advokaters pligter om hvidvask på Færøerne?", expect: /advokat|hvidvask|§|bekendtgørelse/i },
  { q: "Does the Faroese anti-money-laundering order require client identification?", expect: /advokat|hvidvask|§|identi|bekendtgørelse/i },
  { q: "What is coming up for Noah in the next two weeks?", expect: /noah/i, avoid: /zoo|§|advokat/i },
  { q: "Hvornår har Emma fødselsdag?", expect: /emma|fødsel|birth/i, avoid: /§|advokat/i },
  { q: "Where did we go on our last family trip?", expect: /trip|tur|ferie|zoo|rejse|travel/i, avoid: /§|advokat/i },
  { q: "Hvad står der i skolens nyhedsbrev fra Aula?", expect: /aula|skole|nyhed|school/i, avoid: /§|advokat/i },
];

type Row = { kind: string; title: string; score: number; sim?: number | null; kw?: string | null };

async function retrieval() {
  const v = await viewer();
  const { retrieve } = await import("@/lib/assistant/retrieve");
  const { selectItems } = await import("@/lib/assistant/context");
  const gbrain = await import("@/lib/gbrain");
  const results: unknown[] = [];
  let kept = 0, passages = 0, noisy = 0, missed = 0;
  for (const { q, expect, avoid } of QUESTIONS) {
    const hits = await gbrain.search(v, q, { limit: 12, relevant: true });
    const r = await retrieve(v, q, { tz: "Europe/Copenhagen" });
    const items = selectItems(r.items);
    const rows: Row[] = hits.map((h) => ({
      kind: h.kind, title: h.node ? `${h.node.type}: ${h.node.label}` : `passage: ${h.chunk!.sourceTitle} — ${h.chunk!.text.slice(0, 60).replace(/\s+/g, " ")}`,
      score: h.score, sim: (h as { sim?: number | null }).sim ?? null, kw: (h as { kw?: string | null }).kw ?? null,
    }));
    const titles = items.map((i) => `${i.kind}: ${i.title}${i.kind === "passage" ? ` — ${i.text.slice(0, 60).replace(/\s+/g, " ")}` : ""}`);
    const text = items.map((i) => `${i.title} ${"text" in i ? i.text : ""}`).join("\n");
    const ok = expect.test(text);
    const bad = avoid ? items.filter((i) => avoid.test(`${i.title} ${"text" in i ? i.text : ""}`)).length : 0;
    kept += items.length; passages += items.filter((i) => i.kind === "passage").length; noisy += bad; if (!ok) missed++;
    console.log(`\n■ ${q}\n  search hits (${hits.length}):`);
    for (const h of rows) console.log(`    ${h.score.toFixed(4)} sim=${h.sim == null ? "  -  " : h.sim.toFixed(3)} kw=${h.kw ?? "-"}  ${h.title.slice(0, 110)}`);
    console.log(`  context (${items.length} items, ${items.filter((i) => i.kind === "passage").length} passages) · expected found: ${ok ? "yes" : "NO"} · off-topic: ${bad}`);
    for (const t of titles) console.log(`    - ${t.slice(0, 120)}${avoid?.test(t) ? "   <- off-topic" : ""}`);
    results.push({ q, hits: rows, context: titles, ok, offTopic: bad });
  }
  console.log(`\nTOTAL context items ${kept} · passages ${passages} · off-topic ${noisy} · questions missing what they need ${missed}`);
  out.retrieval = { results, totals: { kept, passages, noisy, missed } };
}

/* ── Live highlights ───────────────────────────────────────────────────────────────────────────────────── */

const SENTENCES: { s: string; want: string[]; not: string[] }[] = [
  { s: "Emma starter til svømning den 12. marts kl. 16.30 i Bellahøj Svømmestadion.", want: ["Bellahøj Svømmestadion"], not: ["12. marts", "svømning", "16.30"] },
  { s: "Lars Petersen ringede i går om fodboldkampen.", want: ["Lars Petersen"], not: ["fodboldkampen", "i går"] },
  { s: "We met Sophie Turner at the Copenhagen Zoo on 4 May.", want: ["Sophie Turner", "Copenhagen Zoo"], not: ["4 May"] },
  { s: "Noah skal til tandlæge hos Mette Kjær på tirsdag.", want: ["Mette Kjær"], not: ["tandlæge", "tirsdag"] },
  { s: "Husk at betale 450 kr. for klassefesten senest fredag.", want: [], not: ["450 kr.", "klassefesten", "fredag"] },
  { s: "Anders Bach Jensen er ny træner i Brønshøj Boldklub.", want: ["Anders Bach Jensen", "Brønshøj Boldklub"], not: ["træner"] },
  { s: "The piano lesson moved to Thursday at 5 pm.", want: [], not: ["piano lesson", "Thursday", "5 pm"] },
  { s: "Mormor kommer på besøg i weekenden med kage.", want: [], not: ["weekenden", "kage", "besøg"] },
  { s: "Ida Holm from Vanløse Skole emailed about the trip to Legoland.", want: ["Ida Holm", "Vanløse Skole", "Legoland"], not: ["trip"] },
  { s: "Emma har fået en ny cykel og skal til gymnastik hos Ballerup Gymnastikforening.", want: ["Ballerup Gymnastikforening"], not: ["cykel", "gymnastik"] },
];

async function highlights() {
  const v = await viewer();
  const live = await import("@/lib/mentions/live/server");
  const mux = await import("@/lib/mux");
  const lex = await live.loadLexicon(v);
  const results: unknown[] = [];
  let pass = 0, wantHit = 0, wantAll = 0, falsePos = 0, prompt = 0, cached = 0, ms = 0;
  for (const { s, want, not } of SENTENCES) {
    const t0 = Date.now();
    const { r, usage } = await mux.meterUsage(async (calls) => ({ r: await live.readSentence(v, lex, s, false), usage: mux.sumUsage(calls) }));
    const took = Date.now() - t0;
    const found = r.result.entities.map((e) => ({ text: s.slice(e.at, e.at + e.len) || e.label, label: e.label, type: e.type, known: !!e.nodeId }));
    const lower = found.map((f) => f.text.toLowerCase());
    const hitWant = want.filter((w) => lower.some((l) => l.includes(w.toLowerCase()) || w.toLowerCase().includes(l)));
    // Wrong: a marked thing that is (part of) a phrase that isn't a thing, unless it is also one of the wanted names.
    const isWanted = (l: string) => want.some((w) => l.includes(w.toLowerCase()));
    const fp = not.filter((n) => lower.some((l) => !isWanted(l) && (l === n.toLowerCase() || l.includes(n.toLowerCase()) || n.toLowerCase().includes(l))));
    wantHit += hitWant.length; wantAll += want.length; falsePos += fp.length; prompt += usage.promptTokens; cached += usage.cachedTokens; ms += took;
    const ok = hitWant.length === want.length && fp.length === 0;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${s}\n      marked: ${found.map((f) => `${f.text} (${f.type}${f.known ? ", known" : ""})`).join(", ") || "—"}${fp.length ? `\n      wrongly marked: ${fp.join(", ")}` : ""}${hitWant.length < want.length ? `\n      missed: ${want.filter((w) => !hitWant.includes(w)).join(", ")}` : ""}\n      prompt ${usage.promptTokens} (cached ${usage.cachedTokens}) · completion ${usage.completionTokens} · ${took} ms`);
    results.push({ s, found, ok, missed: want.filter((w) => !hitWant.includes(w)), wrong: fp, usage, ms: took });
  }
  console.log(`\nTOTAL ${pass}/${SENTENCES.length} sentences right · names found ${wantHit}/${wantAll} · wrongly marked ${falsePos} · prompt ${prompt} (cached ${cached}) · ${ms} ms`);
  out.highlights = { results, totals: { pass, wantHit, wantAll, falsePos, prompt, cached, ms } };
}

/* ── Compliance ────────────────────────────────────────────────────────────────────────────────────────── */

/** Chat answers to check, in one conversation: ok = no breach in them (most answers aren't about the rules at all). */
const TEXTS: { name: string; ok: boolean; text: string }[] = [
  { name: "unrelated (swimming)", ok: true, text: "Emma's swimming practice is on Tuesdays at 16:30 at Bellahøj Pool. She needs her goggles, a towel and a swim cap." },
  { name: "compliant 1", ok: true, text: "Klientmidler sættes ind på en særskilt klientkonto, adskilt fra kontorets egne midler, og kontoen afstemmes dagligt. Renter af klientkontoen udbetales til klienten, og klienten får besked om negative renter, når mandatet etableres. Klientkontoerklæringen indsendes elektronisk inden fristen." },
  { name: "breach 1 (own account, interest)", ok: false, text: "Vi sætter klientens penge ind på kontorets egen driftskonto sammen med vores egne midler, og renterne af dem beholder vi selv. Negative renter trækker vi fra klientkontoen uden at fortælle klienten det." },
  { name: "unrelated (dentist, Danish)", ok: true, text: "Noah skal til tandlæge hos Tandlægerne Søndergade den 12. maj kl. 14. Husk sygesikringskortet." },
  { name: "breach 2 (declaration)", ok: false, text: "Klientkontoerklæringen for i år indsender vi ikke; den sender vi på papir næste år, og revisoren behøver ikke at attestere den." },
  { name: "compliant 2", ok: true, text: "Kontoret har sin klientkonto i banken i kontorets navn, og den hedder klientkonto. Betalingen af negative renter bogføres den dag, banken trækker beløbet." },
  { name: "breach 3 (no licence)", ok: false, text: "Selv om advokaten har deponeret sin beskikkelse, beholder han klienternes penge på klientkontoen, indtil sagerne er afsluttet." },
  { name: "unrelated (law question answered neutrally)", ok: true, text: "BEK 1081 handler om advokaters pligter med klientmidler på Færøerne: klientkonti, renter, værdipapirer og klientkontoerklæringen." },
];

async function compliance() {
  const v = await viewer();
  const mux = await import("@/lib/mux");
  const { checkText } = await import("@/lib/compliance");
  const { corpora } = await import("@/db/schema");
  const { db } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const all = await db.select({ id: corpora.id, name: corpora.name }).from(corpora).where(eq(corpora.graphId, v.graphId));
  const bek = all.filter((c) => /bekendtg|BEK|1081/i.test(c.name)).map((c) => c.id);
  const res: unknown[] = [];
  const conv = crypto.randomUUID();
  let right = 0, prompt = 0, cached = 0, completion = 0, ms = 0;
  for (const { name, ok, text } of TEXTS) {
    const t0 = Date.now();
    const r = await mux.meterUsage(async (calls) => {
      const result = await checkText(v, { text, targetType: "message", targetId: null, context: { missing: false, corpusIds: process.env.EVAL_NAMED ? bek : null, persist: false, affinity: `compliance:chat:${conv}` } });
      return { result, usage: mux.sumUsage(calls) };
    });
    const took = Date.now() - t0;
    const breaches = r.result.findings.filter((x) => x.verdict === "non_compliant");
    const good = ok ? breaches.length === 0 : breaches.length > 0;
    if (good) right++;
    prompt += r.usage.promptTokens; cached += r.usage.cachedTokens; completion += r.usage.completionTokens; ms += took;
    const f = r.result.findings.map((x) => `${x.verdict} ${x.rule.ref}: ${x.explanation.slice(0, 110)}`);
    console.log(`\n■ ${good ? "RIGHT" : "WRONG"} ${name}: ${r.result.status} · ${r.result.rulesChecked} rules · ${f.length} findings · prompt ${r.usage.promptTokens} (cached ${r.usage.cachedTokens}) · completion ${r.usage.completionTokens} · calls ${r.usage.calls} · ${took} ms`);
    for (const x of f) console.log(`    ${x}`);
    res.push({ name, ok, good, status: r.result.status, findings: f, usage: r.usage, ms: took });
  }
  console.log(`\nTOTAL ${right}/${TEXTS.length} verdicts right · prompt ${prompt} (cached ${cached}) · completion ${completion} · ${ms} ms`);
  out.compliance = { res, totals: { right, prompt, cached, completion, ms } };
}

/* ── Prompt cache across consecutive calls of one job ──────────────────────────────────────────────────── */

/**
 * The real prompt builders of each background job, called a few times in a row with different items (as the job
 * does), with the job's mux meta. What matters is `cached` on the 2nd and later calls: the prefix they share.
 * `--old` builds the meta the way the code did before affinity was set (traceId only).
 */
async function cache() {
  const old = args.includes("--old");
  const v = await viewer();
  const mux = await import("@/lib/mux");
  const { db } = await import("@/db");
  const { chunks, sources, nodes } = await import("@/db/schema");
  const { and, asc, eq, ilike } = await import("drizzle-orm");
  const run = async (job: string, calls: { messages: import("@/lib/mux").MuxMessage[]; meta: import("@/lib/mux").MuxCallMeta; route: import("@/lib/mux").MuxRoute }[]) => {
    const rows: string[] = [];
    for (const c of calls) {
      const t0 = Date.now();
      const r = await mux.complete({ route: c.route, messages: c.messages, maxTokens: 40, temperature: 0, json: true, meta: c.meta });
      rows.push(`prompt ${r.usage?.promptTokens ?? "?"} cached ${r.usage?.cachedTokens ?? "?"} (${Date.now() - t0} ms)`);
    }
    console.log(`${job.padEnd(18)} ${rows.join("  →  ")}`);
    (out.cache ??= {} as Record<string, string[]>);
    (out.cache as Record<string, string[]>)[job] = rows;
  };
  const textOf = async (title: string, n: number) => {
    const [src] = await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(eq(sources.graphId, v.graphId), ilike(sources.title, `%${title}%`))).limit(1);
    const cs = src ? await db.select({ text: chunks.text }).from(chunks).where(eq(chunks.sourceId, src.id)).orderBy(asc(chunks.idx)).limit(n) : [];
    return { id: src?.id ?? "none", title: src?.title ?? title, parts: cs.map((c) => c.text) };
  };

  // Document extraction: the parts of one document, one after another (pipeline readFacts).
  const { buildExtractionMessages } = await import("@/lib/ingest/extraction");
  const people = await db.select({ id: nodes.id, label: nodes.label, aliases: nodes.aliases }).from(nodes).where(and(eq(nodes.graphId, v.graphId), eq(nodes.type, "person"))).limit(80);
  const doc = await textOf("LBK nr 289", 3);
  await run("extraction", doc.parts.map((t) => ({
    route: "agent", messages: buildExtractionMessages({ title: doc.title, text: t, known: people.map((p) => ({ id: p.id, label: p.label, aliases: p.aliases ?? [] })), today: new Date(), viewerName: v.name }),
    meta: { userId: v.id, agent: "library-ingest", traceId: doc.id, ...(old ? {} : { affinity: `source:${doc.id}` }), graphId: v.graphId },
  })));

  // Rule reading, pass 2: passages of one corpus.
  const prompts = await import("@/lib/corpus/read/prompts");
  const law = await textOf("BEK nr 1081", 3);
  const set = { name: "BEK nr 1081 af 13/07/2023", kind: "regulation", authority: "Justitsministeriet", binding: "binding" } as never;
  await run("rule reading p2", law.parts.map((t) => ({
    route: "smart", messages: prompts.extractMessages({ set, sourceTitle: law.title, passage: t, units: (t.match(/§ ?\d+[a-z]?/g) ?? ["§ 1"]).map((k) => ({ key: k, label: k })), locale: "en", known: [] }),
    meta: { userId: v.id, agent: "my-graph:rule-reader", graphId: v.graphId, traceId: "corpus-eval", ...(old ? {} : { affinity: "corpus:corpus-eval:p2" }) },
  })));

  // Web facts: two answers' pages in one conversation.
  const web = (await import("@/lib/web")) as { FACT_PROMPT?: string };
  if (web.FACT_PROMPT) {
    const zoo = await textOf("Copenhagen Zoo", 2);
    const conv = "conv-eval";
    await run("web facts", zoo.parts.map((t, i) => ({
      route: "agent", messages: [{ role: "system", content: web.FACT_PROMPT! }, { role: "user", content: `Question asked: question ${i}\n\nGraph nodes:\n- id x · place · "Zoo"\n\nPages:\n[page 1] url: https://zoo.dk\n"""\n${t}\n"""` }],
      meta: { userId: v.id, agent: "my-graph:web-facts", traceId: conv, affinity: conv, graphId: v.graphId },
    })));
  }

  // Drafting: a document, then a redraft of one of its sections.
  const { draftMessages } = await import("@/lib/artifacts/draft-pure");
  const ev = (key: string, text: string) => ({ key, text, kind: "node" as const, citation: { kind: "node", nodeId: key, label: key } as never });
  const evidence = [ev("E1", "Emma swims on Thursdays at 16:00 at Badeland pool."), ev("E2", "Emma needs new swimming goggles."), ev("E3", "Noah has a dentist appointment on 2 December.")];
  const base = { kind: "brief" as const, title: "The week", query: { question: "the coming week" }, evidence, tone: "Warm and plain.", language: "en" as const };
  await run("draft", [
    { route: "smart", messages: draftMessages(base), meta: { userId: v.id, agent: "my-graph-artifacts", graphId: v.graphId, ...(old ? {} : { affinity: "artifact:eval" }) } },
    { route: "smart", messages: draftMessages({ ...base, query: { question: "the coming week — Swimming" }, section: { title: "Swimming", current: "Emma swims on Thursdays." } }), meta: { userId: v.id, agent: "my-graph-artifacts", graphId: v.graphId, ...(old ? {} : { affinity: "artifact:eval" }) } },
    { route: "smart", messages: draftMessages({ ...base, query: { question: "the coming week — Dentist" }, section: { title: "Dentist", current: "Noah goes to the dentist." } }), meta: { userId: v.id, agent: "my-graph-artifacts", graphId: v.graphId, ...(old ? {} : { affinity: "artifact:eval" }) } },
  ]);
}

/* ── Main ──────────────────────────────────────────────────────────────────────────────────────────────── */

async function main() {
  if (cmd === "retrieval") await retrieval();
  else if (cmd === "highlights") await highlights();
  else if (cmd === "compliance") await compliance();
  else if (cmd === "cache") await cache();
  else throw new Error(`Unknown command ${cmd}`);
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log(`\nSaved to ${JSON_OUT}`); }
  const { sql } = await import("@/db");
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
