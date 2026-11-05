/**
 * Tokens per chat turn, for a fixed set of realistic turns against a running dev server.
 *
 *   npx tsx scripts/token-report.ts [--base http://localhost:3917] [--json out.json] [--only person-en,multi]
 *
 * Signs in with REPORT_EMAIL / REPORT_PASSWORD (default: the demo account; the session cookie is kept in
 * $TMPDIR/mg-token-report.cookie because sign-in is rate-limited). Each turn's `done` event carries `usage` (every mux
 * call of the turn: prompt, cached and completion tokens; `answer` is the answer model alone). Prints a table, and
 * with --json saves the answers and their citations so two runs (before / after a change) can be compared.
 *
 * Turns: a question about a person (English), the same kind in Danish, one asked from a person's page, and a
 * 6-turn conversation from that page with page actions offered (one turn calls one: this script plays the browser
 * and answers "done"). It writes conversations into the demo graph; don't run it during a demo.
 *
 * Columns `plan` (the tool planner: its calls and ms) and `other` (title …) come from the turn's per-agent usage.
 * The compliance check of each answer runs after `done`, so it isn't in these numbers: measure it with
 * `npx tsx scripts/assistant-eval.ts compliance`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = (arg("base", process.env.REPORT_BASE ?? "http://localhost:3917") as string).replace(/\/$/, "");
const JSON_OUT = arg("json");
const ONLY = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const EMAIL = process.env.REPORT_EMAIL ?? "anna@example.com";
const PASSWORD = process.env.REPORT_PASSWORD ?? "demo-demo-demo";
const COOKIE_FILE = join(process.env.TMPDIR ?? tmpdir(), "mg-token-report.cookie");

let cookie = "";

async function signedIn(): Promise<boolean> {
  if (!cookie) return false;
  const r = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  return r.ok;
}

async function signIn() {
  if (existsSync(COOKIE_FILE)) {
    cookie = readFileSync(COOKIE_FILE, "utf8").trim();
    if (await signedIn()) return;
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed with ${res.status}: ${await res.text()}`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Sign-in returned no session cookie");
  writeFileSync(COOKIE_FILE, cookie);
}

type AgentUsage = { prompt: number; completion: number; cached: number; calls: number; ms?: number };
type Usage = { prompt: number; completion: number; cached: number; calls: number; answer: { prompt: number; completion: number; cached: number; rounds: number }; agents?: Record<string, AgentUsage> };
type Citation = { n: number; title: string; sourceId?: string; nodeId?: string; edgeId?: string };
type Done = { messageId: string; text: string; citations: Citation[]; route: string | null; model: string | null; usage?: Usage; degraded: unknown };
type Page = { path: string; kind: string; id: string; title?: string };

/** What the Ask window would send from a person's page: two actions, one that reads and one that changes. */
const ACTIONS = [
  {
    name: "page_profile_add_note", title: "Add a note to this profile", danger: "change",
    description: "Appends a short note to the open person's profile notes.",
    input: { type: "object", properties: { text: { type: "string", description: "The note, one or two sentences." } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "page_profile_open_section", title: "Open a section of this profile", danger: "read",
    description: "Scrolls the profile to one of its sections.",
    input: { type: "object", properties: { section: { type: "string", enum: ["facts", "notes", "timeline", "documents"] } }, required: ["section"], additionalProperties: false },
  },
];

async function ask(question: string, opts: { conversationId?: string | null; page?: Page | null; actions?: unknown[] } = {}): Promise<{ done: Done | null; ms: number; conversationId: string | null; actionsRun: number }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: BASE },
    body: JSON.stringify({ question, conversationId: opts.conversationId ?? null, page: opts.page ?? null, actions: opts.actions ?? null }),
  });
  if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}: ${await res.text()}`);
  let conversationId = res.headers.get("x-conversation-id");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done: Done | null = null;
  let actionsRun = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
      const data = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      const body = JSON.parse(data);
      if (event === "start") conversationId = body.conversationId;
      if (event === "done") done = body;
      if (event === "error") throw new Error(`chat error: ${body.message}`);
      if (event === "client_action") {
        // Play the browser: the person approved, the page did it.
        actionsRun++;
        const summary = body.name === "page_profile_add_note" ? "Added the note to the profile." : "Opened the section.";
        await fetch(`${BASE}/api/chat/${conversationId}/action`, {
          method: "POST", headers: { "content-type": "application/json", cookie, origin: BASE },
          body: JSON.stringify({ callId: body.callId, status: "done", summary, result: { ok: true, input: body.input } }),
        });
      }
    }
  }
  return { done, ms: performance.now() - t0, conversationId, actionsRun };
}

async function findPerson(name: string): Promise<{ id: string; label: string } | null> {
  const r = await fetch(`${BASE}/api/people`, { headers: { cookie } });
  if (!r.ok) return null;
  const j = (await r.json()) as Record<string, unknown>;
  const all = Object.values(j).flatMap((v) => (Array.isArray(v) ? v : [])) as { id?: string; label?: string; name?: string }[];
  const hit = all.find((p) => (p.label ?? p.name ?? "").trim().toLowerCase() === name.toLowerCase())
    ?? all.find((p) => (p.label ?? p.name ?? "").toLowerCase().startsWith(name.toLowerCase()));
  return hit?.id ? { id: hit.id, label: hit.label ?? hit.name ?? name } : null;
}

type Row = { set: string; turn: number; question: string; ms: number; usage: Usage | null; route: string | null; citations: number; actions: number; text: string; cites: Citation[] };

async function main() {
  await signIn();
  const rows: Row[] = [];
  const want = (s: string) => !ONLY || ONLY.includes(s);
  const record = (set: string, turn: number, question: string, r: Awaited<ReturnType<typeof ask>>) => {
    const d = r.done;
    rows.push({
      set, turn, question, ms: Math.round(r.ms), usage: d?.usage ?? null, route: d?.route ?? null, citations: d?.citations.length ?? 0,
      actions: r.actionsRun, text: d?.text ?? "(no answer)", cites: (d?.citations ?? []).map((c) => ({ n: c.n, title: c.title, sourceId: c.sourceId, nodeId: c.nodeId, edgeId: c.edgeId })),
    });
    const u = d?.usage;
    console.log(`${set} #${turn}  ${u ? `prompt ${u.prompt} (cached ${u.cached}) · completion ${u.completion} · calls ${u.calls}` : "no usage"} · ${Math.round(r.ms)} ms · ${d?.citations.length ?? 0} citations${r.actionsRun ? ` · ${r.actionsRun} action(s)` : ""}`);
  };

  const emma = await findPerson("Emma");
  const page: Page | null = emma ? { path: `/people/${emma.id}`, kind: "person", id: emma.id, title: emma.label } : null;
  if (!page) console.warn("No person called Emma found: the page turns run without a page.");

  if (want("person-en")) record("person-en", 1, "When is Emma's swimming practice, and what does she need to bring?", await ask("When is Emma's swimming practice, and what does she need to bring?"));
  if (want("person-da")) record("person-da", 1, "Hvem er Noahs læge, og hvornår skal han til lægen næste gang?", await ask("Hvem er Noahs læge, og hvornår skal han til lægen næste gang?"));
  if (want("page")) record("page", 1, "What's new with her?", await ask("What's new with her?", { page }));

  if (want("multi")) {
    const turns = [
      "What do we know about Emma?",
      "When is her next swimming practice?",
      "Hvad skal hun have med til svømning?",
      "Add a note on her profile that she needs new swimming goggles.",
      "And Noah: anything coming up for him in the next two weeks?",
      "Summarise the plan for the coming week in three bullets.",
    ];
    let conversationId: string | null = null;
    for (const [i, q] of turns.entries()) {
      const r = await ask(q, { conversationId, page, actions: ACTIONS });
      conversationId = r.conversationId;
      record("multi", i + 1, q, r);
    }
  }

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log("\nset        turn   prompt   cached  complet.  calls  rounds   ms     cites  plan(calls/ms)  route");
  for (const r of rows) {
    const u = r.usage;
    const plan = u?.agents?.["my-graph:tools"];
    console.log(`${r.set.padEnd(10)} ${pad(r.turn, 4)} ${pad(u?.prompt ?? "-", 8)} ${pad(u?.cached ?? "-", 8)} ${pad(u?.completion ?? "-", 9)} ${pad(u?.calls ?? "-", 6)} ${pad(u?.answer.rounds ?? "-", 7)} ${pad(r.ms, 6)} ${pad(r.citations, 6)}  ${pad(plan ? `${plan.calls}/${plan.ms ?? "?"}` : "skipped", 14)}  ${r.route ?? "-"}`);
  }
  const planMs = rows.reduce((a, r) => a + (r.usage?.agents?.["my-graph:tools"]?.ms ?? 0), 0);
  const planned = rows.filter((r) => r.usage?.agents?.["my-graph:tools"]).length;
  console.log(`tool planner: ran on ${planned} of ${rows.length} turns, ${planMs} ms in all`);
  const sum = (k: "prompt" | "cached" | "completion") => rows.reduce((a, r) => a + (r.usage?.[k] ?? 0), 0);
  console.log(`${"total".padEnd(15)} ${pad(sum("prompt"), 8)} ${pad(sum("cached"), 8)} ${pad(sum("completion"), 9)}`);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, rows }, null, 2));
    console.log(`\nSaved answers and citations to ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
