/**
 * Time every main page and API against a running server, cold (first request) and warm (median and p95 of N more).
 *
 *   npx tsx scripts/perf-measure.ts [--base http://localhost:3917] [--runs 5] [--json out.json] [--only people,wiki]
 *
 * Signs in with PERF_EMAIL / PERF_PASSWORD (default: the demo account). Reads ids for detail pages from the list
 * APIs, so it works on any seeded database. Times are wall-clock until the whole body has arrived; on a local server
 * that is the server time plus a millisecond or so. In `next dev`, "cold" includes compiling the route the first time.
 * Prints metadata only: route, status, timings. Never prints response bodies.
 */
export {};

type Target = { name: string; path: string; kind: "page" | "api" };
type Result = Target & { status: number; coldMs: number; p50Ms: number; p95Ms: number; maxMs: number; bytes: number };

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = (arg("base", process.env.PERF_BASE ?? "http://localhost:3917") as string).replace(/\/$/, "");
const RUNS = Math.max(1, Number(arg("runs", "5")));
const ONLY = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const JSON_OUT = arg("json");
const EMAIL = process.env.PERF_EMAIL ?? "anna@example.com";
const PASSWORD = process.env.PERF_PASSWORD ?? "demo-demo-demo";

let cookie = "";

async function req(path: string, init: RequestInit = {}): Promise<{ status: number; ms: number; bytes: number; body: string }> {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    ...init, redirect: "manual",
    headers: { cookie, origin: BASE, "user-agent": "my-graph-perf/1", ...(init.headers ?? {}) },
  });
  const body = await res.text();
  return { status: res.status, ms: performance.now() - t0, bytes: body.length, body };
}

async function signIn() {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed with ${res.status}`);
  const set = res.headers.getSetCookie?.() ?? [];
  cookie = set.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Sign-in returned no session cookie");
}

async function firstId(path: string, pick: (j: unknown) => string | undefined): Promise<string | undefined> {
  try {
    const r = await req(path);
    if (r.status !== 200) return undefined;
    return pick(JSON.parse(r.body));
  } catch {
    return undefined;
  }
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

type J = Record<string, unknown>;
const at = (j: unknown, key: string) => ((j as J)?.[key] as J[] | undefined) ?? [];

async function targets(): Promise<Target[]> {
  const personId = await firstId("/api/people", (j) => {
    const centers = at(j, "centers") as { id: string; isViewer: boolean }[];
    return (centers.find((c) => !c.isViewer) ?? centers[0])?.id;
  });
  const libraryId = await firstId("/api/library", (j) => (at(j, "items")[0] as { id?: string })?.id);
  const wikiSlug = await firstId("/api/wiki", (j) => (at(j, "pages")[0] as { slug?: string })?.slug);
  const changeId = await firstId("/api/changes", (j) => (at(j, "changeSets")[0] as { id?: string })?.id);
  const chatId = await firstId("/api/chat", (j) => (at(j, "conversations")[0] as { id?: string })?.id);
  const recordingId = await firstId("/api/recordings", (j) => (at(j, "recordings")[0] as { id?: string })?.id);
  const docId = await firstId("/api/artifacts", (j) => (at(j, "artifacts")[0] as { id?: string })?.id);

  const t: Target[] = [
    { name: "Today", path: "/", kind: "page" },
    { name: "Chat", path: "/chat", kind: "page" },
    ...(chatId ? [{ name: "Conversation", path: `/chat/${chatId}`, kind: "page" as const }] : []),
    { name: "People", path: "/people", kind: "page" },
    ...(personId ? [{ name: "Person", path: `/people/${personId}`, kind: "page" as const }] : []),
    { name: "Timeline", path: "/timeline", kind: "page" },
    { name: "Library", path: "/library", kind: "page" },
    ...(libraryId ? [{ name: "Library item", path: `/library/${libraryId}`, kind: "page" as const }] : []),
    { name: "Wiki", path: "/wiki", kind: "page" },
    ...(wikiSlug ? [{ name: "Wiki page", path: `/wiki/${wikiSlug}`, kind: "page" as const }] : []),
    { name: "Graph", path: "/graph", kind: "page" },
    { name: "Changes", path: "/changes", kind: "page" },
    ...(changeId ? [{ name: "Change set", path: `/changes/${changeId}`, kind: "page" as const }] : []),
    { name: "History", path: "/history", kind: "page" },
    { name: "Memory", path: "/memory", kind: "page" },
    { name: "Automations", path: "/automations", kind: "page" },
    { name: "Connections", path: "/connections", kind: "page" },
    { name: "Documents", path: "/artifacts", kind: "page" },
    ...(docId ? [{ name: "Document", path: `/artifacts/${docId}`, kind: "page" as const }] : []),
    { name: "Corpora", path: "/corpora", kind: "page" },
    { name: "Clinical", path: "/clinical", kind: "page" },
    { name: "Recordings", path: "/recordings", kind: "page" },
    ...(recordingId ? [{ name: "Recording", path: `/recordings/${recordingId}`, kind: "page" as const }] : []),

    { name: "API today", path: "/api/today", kind: "api" },
    { name: "API chat list", path: "/api/chat", kind: "api" },
    ...(chatId ? [{ name: "API conversation", path: `/api/chat/${chatId}`, kind: "api" as const }] : []),
    { name: "API people", path: "/api/people", kind: "api" },
    ...(personId ? [{ name: "API person", path: `/api/people/${personId}`, kind: "api" as const }] : []),
    { name: "API timeline", path: "/api/timeline", kind: "api" },
    { name: "API library", path: "/api/library", kind: "api" },
    ...(libraryId ? [{ name: "API library item", path: `/api/library/${libraryId}`, kind: "api" as const }] : []),
    { name: "API wiki", path: "/api/wiki", kind: "api" },
    ...(wikiSlug ? [{ name: "API wiki page", path: `/api/wiki/${wikiSlug}`, kind: "api" as const }] : []),
    { name: "API graph", path: "/api/graph", kind: "api" },
    { name: "API changes", path: "/api/changes", kind: "api" },
    { name: "API history", path: "/api/history", kind: "api" },
    { name: "API memory", path: "/api/memory", kind: "api" },
    { name: "API automations", path: "/api/automations", kind: "api" },
    { name: "API connections", path: "/api/connections", kind: "api" },
    { name: "API documents", path: "/api/artifacts", kind: "api" },
    { name: "API corpora", path: "/api/corpora", kind: "api" },
    { name: "API recordings", path: "/api/recordings", kind: "api" },
    { name: "API reminders", path: "/api/reminders", kind: "api" },
    { name: "API jobs", path: "/api/jobs", kind: "api" },
  ];
  return ONLY ? t.filter((x) => ONLY.some((o) => x.name.toLowerCase().includes(o.toLowerCase()) || x.path.includes(o))) : t;
}

async function measure(t: Target): Promise<Result> {
  const cold = await req(t.path);
  const warm: number[] = [];
  for (let i = 0; i < RUNS; i++) warm.push((await req(t.path)).ms);
  return {
    ...t, status: cold.status, coldMs: cold.ms, bytes: cold.bytes,
    p50Ms: quantile(warm, 0.5), p95Ms: quantile(warm, 0.95), maxMs: Math.max(...warm),
  };
}

async function main() {
  await signIn();
  const list = await targets();
  const results: Result[] = [];
  for (const t of list) results.push(await measure(t));
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => String(Math.round(n)).padStart(7);
  console.log(`${pad("Route", 22)} ${pad("Path", 52)} status    cold     p50     p95   (ms, ${RUNS} warm runs)`);
  for (const r of results) {
    const flag = r.p50Ms > 400 ? "  > 400" : "";
    console.log(`${pad(r.name, 22)} ${pad(r.path.slice(0, 52), 52)} ${String(r.status).padStart(6)} ${num(r.coldMs)} ${num(r.p50Ms)} ${num(r.p95Ms)}${flag}`);
  }
  const pages = results.filter((r) => r.kind === "page");
  console.log(`\nPages: median of p50 ${Math.round(quantile(pages.map((r) => r.p50Ms), 0.5))} ms, slowest ${pages.sort((a, b) => b.p50Ms - a.p50Ms).slice(0, 3).map((r) => `${r.name} ${Math.round(r.p50Ms)}`).join(", ")}`);
  if (JSON_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, runs: RUNS, at: new Date().toISOString(), results }, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
