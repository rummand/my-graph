// The screens for "My Graph, explained": signs in to a running My Graph (default http://localhost:3917) as Anna, opens
// each screen the film shows and saves it at 2x, with the boxes the film zooms to and highlights.
//
//   node ops/video/my-graph/shots.mjs                    # every shot -> build/shots/<name>.png + <name>.json
//   ONLY=today,ask-steps node ops/video/my-graph/shots.mjs
//   BASE=http://localhost:3917 EMAIL=anna@example.com PASSWORD=demo-demo-demo node ...
//
// <name>.json holds { w, h, marks: { mark: [x, y, w, h] } } in CSS pixels of the 1440-wide page, so script.json can say
// `"box": "today#week"` instead of guessing coordinates. The demo household is shared with the end-to-end tests, so
// rows they leave behind (names like "ui-test-note-1570.txt" or "contact zbtyvz") are hidden before each picture, and
// every picture checks it is in English and in the asked-for theme (another session may switch Anna's settings).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "build", "shots");
const BASE = process.env.BASE ?? "http://localhost:3917";
const EMAIL = process.env.EMAIL ?? "anna@example.com";
const PASSWORD = process.env.PASSWORD ?? "demo-demo-demo";
fs.mkdirSync(OUT, { recursive: true });

// Ids in the demo household (stable across the seeded demo).
const EMMA = "2227e904-28ed-4c5a-8941-acf4ae4da5ab";
const ANNA = "36f5f721-9d68-4c64-a237-18a04cfe4028";
const NOAH = "38b444df-2478-461c-99ce-e3ccafab64c2";

/** Rows left by the end-to-end tests; hidden in every picture. */
const JUNK = String.raw`e2e|ui[- ]?test|ui smoke|test person|(household|parents-only) contact|\d{10,}|\b(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{6}\b|probe set|smoke test|smoke swim|swimplan|smopack|smokesuit|service booking|@em about|\[\[|muklbf|zbtyvz|opening hours are 9`;

// A shot: { name, path, graph?, full?, height?, dark?, mobile?, act?(page), marks?: { mark: selector | {text} } }
const T = (text, up) => ({ text, up });
/** The section a heading belongs to (for a box around the whole block). */
const S = (text) => T(text, "section");
/** Scroll the chat's own panel so `text` is near the top (the chat scrolls inside itself, not the page). */
const scrollTo = (text, offset = 120) => async (p) => {
  await p.getByText(text, { exact: false }).first().evaluate((e, off) => {
    let s = e.parentElement; while (s && !(s.scrollHeight > s.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (s) s.scrollTop += e.getBoundingClientRect().top - s.getBoundingClientRect().top - off; else window.scrollBy(0, e.getBoundingClientRect().top - off);
  }, offset);
  await p.waitForTimeout(900);
};
const SHOTS = [
  // 1. What My Graph is
  { name: "node-emma", path: `/node/${EMMA}`, full: true, marks: { know: T("What we know"), came: T("Where Emma came from"), who: T("Who said so"), child: T("Child of"), quote: T("Dear parents, Emma") } },
  // 2. Graphs and sharing
  { name: "graphs", path: "/graphs", marks: { list: T("Mine"), people: T("People in it"), privacy: T("Everyone in the household works") } },
  { name: "switcher", path: "/", act: async (p) => { await p.locator("aside [data-graph-switcher]").first().click(); await p.waitForTimeout(900); } },
  { name: "work-people", path: "/people", graph: "Work" },
  { name: "share-dialog", path: `/people/${ANNA}`, act: async (p) => { await p.getByText("Share with another graph").first().click(); await p.waitForTimeout(2500); }, marks: { dialog: "[role=dialog]" } },
  // 3. Today
  { name: "today", path: "/", full: true, marks: { week: T("This week"), brief: S("Today’s brief"), ready: S("Ready when you are"), proposed: S("Proposed changes"), needs: S("Needs you"), todo: S("To do") } },
  // 4. Ask
  { name: "ask-empty", path: "/chat", marks: { starters: T("What's coming up for Emma this week?") } },
  { name: "ask-teacher", path: "/chat/18be075b-e745-4e42-85fc-5d876dde8770", act: scrollTo("Who is Emma's teacher?", 160), marks: { teacher: T("Who is Emma's teacher?"), steps: T("Worked for 11s"), source: T("Oakwood School — Letter"), model: T("Quick answer from") } },
  { name: "ask-approve", path: "/chat/18be075b-e745-4e42-85fc-5d876dde8770", act: scrollTo("When is the permission slip due?", 60), marks: { proposal: T("Add this reminder?") } },
  { name: "ask-web", path: "/chat/4fa93cd8-6a50-4e66-9ea2-ce78a4a3bc42", act: scrollTo("Look up", 30), marks: { sources: T("Web page: Copenhagen Zoo"), trip: T("I see you have a") } },
  { name: "ask-clarify", path: "/chat/7a6bb864-a69d-4e05-b245-14a813247ae5", marks: { clarify: T("Would you like me to suggest"), proposal: T("Add this reminder?") } },
  // 5. Live highlights, @mentions, the model
  { name: "highlights", path: "/chat", act: async (p) => { await p.locator("textarea").first().click(); await p.keyboard.type("Emma has swimming at Bellahøj Pool on Thursday, and Grandma Birgit picks her up", { delay: 15 }); await p.getByText(/Will add|Add to the graph and send/).first().waitFor({ timeout: 300000 }).catch(() => {}); await p.waitForTimeout(2000); }, marks: { composer: "textarea" } },
  { name: "mention", path: "/chat", act: async (p) => { await p.locator("textarea").first().click(); await p.keyboard.type("What does @Em", { delay: 60 }); await p.getByText(/Looking for/).waitFor({ state: "hidden", timeout: 90000 }).catch(() => {}); await p.waitForTimeout(1500); }, marks: { composer: "textarea", menu: "[role=listbox], [role=menu]" } },
  { name: "model", path: "/people/model", full: true, marks: { emerging: T("Nothing new to decide"), describe: T("Describe part of your world"), inuse: T("In use") } },
  // 6. People
  { name: "people", path: "/people", marks: { needs: T("Needs you") } },
  { name: "person-emma", path: `/people/${EMMA}`, full: true, marks: { touch: T("Keeping in touch"), rel: T("Relationships") } },
  { name: "person-anna", path: `/people/${ANNA}`, full: true, marks: { also: T("Also in"), rel: T("Relationships") } },
  { name: "person-new", path: "/people/new", marks: { how: T("How do they know you?") } },
  // 7. Library
  { name: "library", path: "/library", marks: { drop: T("Drop files here, or paste them"), paste: T("Paste from clipboard"), who: T("New files can be seen by") } },
  { name: "library-dentist", path: "/library/5a746eb1-160a-4947-bdc2-9c89572203b2", full: true, marks: { date: T("Dated 3 Nov 2026"), found: T("Found in this file"), sensitive: T("Health, money or legal papers") } },
  { name: "sara-library", path: "/library", graph: "For Sara", marks: { conv: T("3 in conversation"), letter: T("3 Mar 2024") } },
  { name: "sara-thread", path: "/library", graph: "For Sara", act: async (p) => { await p.getByText("3 in conversation").first().click(); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(2500); } },
  // 8. Timeline
  { name: "timeline", path: "/timeline" },
  { name: "timeline-year", path: "/timeline", act: async (p) => { await p.getByRole("button", { name: "Year", exact: true }).or(p.getByRole("link", { name: "Year", exact: true })).or(p.getByRole("tab", { name: "Year", exact: true })).first().click(); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(2500); } },
  // 9. Wiki
  { name: "wiki-page", path: "/wiki/museum-trip-packing", full: true },
  { name: "wiki-cowrite", path: "/wiki/museum-trip-packing?assist=1", act: async (p) => {
      await p.waitForTimeout(2500);
      const box = p.getByPlaceholder(/For example|write/i).first();
      await box.fill("Add a section with the important dates this term").catch(async () => { await p.locator("textarea").last().fill("Add a section with the important dates this term"); });
      await p.getByRole("button", { name: "Write", exact: true }).first().click();
      await p.getByText("Keep what the assistant wrote?").first().waitFor({ timeout: 240000 }).catch(() => {});
      await p.waitForTimeout(1500);
    }, marks: { keep: T("Keep what the assistant wrote?"), draft: ".cowrite-draft, [data-cowrite], mark" } },
  // 10. Changes and History
  { name: "changes", path: "/changes", marks: { first: "main article, main li, main section > div > div" } },
  { name: "change-skovtur", path: "/changes/7ad068a8-ffb6-4ac5-8444-af7b347155af", full: true, marks: { change1: "input[type=checkbox]", deliver: T("Untick what isn't ready") } },
  { name: "history", path: "/history", full: true },
  { name: "history-compare", path: "/history?from=2026-11-03&to=2026-11-04", full: true, marks: { compare: T("Compare two moments"), checkpoints: T("Checkpoints") } },
  // 11. Memory
  { name: "memory", path: "/memory", full: true, marks: { keeper: T("What the Brain Keeper did"), confirm: T("Waiting for you to confirm") } },
  // 12. Automations
  { name: "automations", path: "/automations", full: true, marks: { checkins: T("Check in on its own"), strict: T("Stricter when nobody is watching"), auto: T("Vaccination letters"), recipes: T("Recipes") } },
  // 13. Connections
  { name: "connections", path: "/connections", full: true, marks: { aula: T("Aula calendar") } },
  // 14. Documents and design sets
  { name: "artifacts", path: "/artifacts" },
  { name: "artifact-report", path: "/artifacts/a1464a84-5799-4ca0-a384-ff021d2349db", full: true },
  { name: "artifact-deck", path: "/artifacts/1cda45be-be35-41cc-b28a-8c3ceac98103" },
  { name: "design-sets", path: "/artifacts/design-sets", full: true },
  // 15. Settings, English and Danish, light and dark
  { name: "settings", path: "/settings", full: true },
  { name: "settings-family", path: "/settings/family", full: true },
  { name: "settings-security", path: "/settings/security", full: true },
  { name: "today-dark", path: "/", dark: true, full: true },
  { name: "people-da", path: "/people", email: "mikkel@example.com", locale: "da" },
  { name: "today-da", path: "/", email: "mikkel@example.com", locale: "da" },
];

const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const browser = await chromium.launch();

async function context(o) {
  const ctx = await browser.newContext({ viewport: o.mobile ? { width: 390, height: 844 } : { width: 1440, height: o.height ?? 900 },
    deviceScaleFactor: 2, colorScheme: o.dark ? "dark" : "light", baseURL: BASE, locale: "en-GB" });
  const p = await ctx.newPage();
  await p.goto("/login", { timeout: 300000 });
  const r = await p.request.post("/api/auth/login", { data: { email: o.email ?? EMAIL, password: PASSWORD }, headers: { origin: BASE }, timeout: 300000 });
  if (!r.ok()) throw new Error(`sign-in ${r.status()}`);
  return { ctx, p };
}

async function switchTo(p, name) {
  const gs = await (await p.request.get("/api/graphs")).json();
  const g = gs.graphs.find((x) => x.name === name);
  if (!g) throw new Error(`no graph ${name}`);
  if (!g.isCurrent) await p.request.post("/api/graphs/switch", { data: { graphId: g.id }, headers: { origin: BASE } });
}

/** Hide the rows the end-to-end tests left behind; drop their dots from a graph picture too. */
async function clean(p) {
  return p.evaluate((src) => {
    const re = new RegExp(src, "i");
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = new Set();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (re.test(t.textContent ?? "")) hits.add(t.parentElement);
    for (const el of hits) {
      if (!el || el.closest("textarea")) continue;
      let row = el.closest("li, tr, article, [role=row], [role=listitem], [role=option]");
      if (!row) {
        // climb to the element that has look-alike siblings (a row in a list of rows)
        let e = el;
        for (let i = 0; i < 9 && e.parentElement && e.parentElement !== document.body; i++) {
          const sib = [...e.parentElement.children].filter((c) => c !== e && c.tagName === e.tagName && c.className === e.className);
          if (sib.length && e.getBoundingClientRect().height < 420) { row = e; break; }
          e = e.parentElement;
        }
      }
      (row ?? el).style.display = "none";
      n++;
    }
    for (const c of document.querySelectorAll("div")) {
      const cy = c._cyreg?.cy;
      if (cy) { const bad = cy.nodes().filter((x) => re.test(String(x.data("label") ?? ""))); n += bad.length; cy.remove(bad); }
    }
    return n;
  }, JUNK);
}

async function rectOf(p, m) {
  const loc = typeof m === "string" ? p.locator(m).first() : p.getByText(m.text, { exact: false }).first();
  let b = await loc.boundingBox().catch(() => null);
  if (b && m.up) {
    const r = await loc.evaluate((e, up) => { const s = e.closest(up); if (!s) return null; const x = s.getBoundingClientRect(); return x.height < 1400 ? { x: x.x, y: x.y, width: x.width, height: x.height } : null; }, m.up).catch(() => null);
    if (r) b = r;
  }
  if (!b) return null;
  const sy = await p.evaluate(() => window.scrollY);
  return [Math.round(b.x), Math.round(b.y + sy), Math.round(b.width), Math.round(b.height)];
}

for (const s of SHOTS) {
  if (only && !only.has(s.name)) continue;
  for (let attempt = 1; ; attempt++) {
    let ctx, p;
    try { ({ ctx, p } = await context(s)); } catch (e) { if (attempt > 3) { console.log(`${s.name}: FAILED ${e.message.split("\n")[0]}`); break; } continue; }
    try {
      if (s.locale) { await p.request.patch("/api/settings", { data: { locale: s.locale }, headers: { origin: BASE } }); }
      await switchTo(p, s.graph ?? "Family");
      await p.goto(s.path, { waitUntil: "networkidle", timeout: 300000 }).catch(() => {});
      await p.waitForTimeout(1200);
      const env = await p.evaluate(() => ({ lang: document.documentElement.lang, theme: document.documentElement.dataset.theme ?? "system" }));
      const wantTheme = s.dark ? "dark" : "light";
      // The theme is only an attribute: set the one this picture wants (another session may have switched Anna's).
      if (env.theme !== "system" && env.theme !== wantTheme) await p.evaluate((th) => { document.documentElement.dataset.theme = th; }, wantTheme);
      if (env.lang !== (s.locale ?? "en")) {
        if (attempt > 45) throw new Error(`${s.name}: still ${env.lang}/${env.theme}`);
        console.log(`${s.name}: page is ${env.lang}/${env.theme}, waiting`);
        await ctx.close(); await new Promise((r) => setTimeout(r, 20000)); continue;
      }
      if (s.act) await s.act(p);
      await p.evaluate((th) => { if (document.documentElement.dataset.theme && document.documentElement.dataset.theme !== th) document.documentElement.dataset.theme = th; }, wantTheme);
      const hidden = await clean(p);
      await p.waitForTimeout(400);
      const marks = {};
      for (const [k, m] of Object.entries(s.marks ?? {})) marks[k] = await rectOf(p, m);
      const size = await p.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      const vp = p.viewportSize();
      await p.screenshot({ path: path.join(OUT, `${s.name}.png`), fullPage: !!s.full });
      fs.writeFileSync(path.join(OUT, `${s.name}.json`), JSON.stringify({ w: vp.width, h: s.full ? size.h : vp.height, path: s.path, graph: s.graph ?? "Family", marks }, null, 1));
      if (s.locale) await p.request.patch("/api/settings", { data: { locale: "en" }, headers: { origin: BASE } });
      console.log(`${s.name.padEnd(18)} ${s.full ? size.h : vp.height}px  hidden ${hidden}  ${Object.entries(marks).filter(([, v]) => !v).map(([k]) => "no " + k).join(" ")}`);
      await ctx.close();
      break;
    } catch (e) {
      await ctx.close();
      if (attempt > 2) { console.log(`${s.name}: FAILED ${e.message.split("\n")[0]}`); break; }
    }
  }
}
// Leave Anna where she was: in Family.
{ const { ctx, p } = await context({}); await switchTo(p, "Family"); await ctx.close(); }
await browser.close();
