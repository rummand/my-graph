/**
 * End-to-end isolation check through the HTTP API (needs the seeded demo data and a running server):
 *   BASE=http://localhost:3918 npx tsx scripts/check-graph-isolation.ts
 * Anna puts recognisable "zebra" content into her Family and Work graphs; Sara (another household, editor of
 * "For Sara") must never see any of it — not in search, chat context, timeline, graph, people, library, wiki,
 * reminders, the brief or by id — and Anna, switching graphs, sees only the graph she is in.
 * Also runs the invite flow (new account, own household) and checks that a viewer can't write.
 */
const BASE = process.env.BASE ?? "http://localhost:3918";
const PASSWORD = "demo-demo-demo";
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log("ok   ", msg);
  else { failures++; console.error("FAIL ", msg); }
};

class Client {
  jar = new Map<string, string>();
  constructor(public name: string) {}
  async req(path: string, init: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { origin: BASE, ...(init.headers ?? {}) };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + path, { method: init.method ?? "GET", headers, body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i), val = pair.slice(i + 1);
      if (!val || /max-age=0/i.test(c)) this.jar.delete(k); else this.jar.set(k, val);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* SSE or HTML */ }
    return { status: res.status, text, json: json as Record<string, any> };
  }
  async login(email: string) {
    const r = await this.req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } });
    if (r.status !== 200) throw new Error(`${this.name} could not sign in: ${r.status} ${r.text}`);
  }
  async switchTo(graphId: string) {
    const r = await this.req("/api/graphs/switch", { method: "POST", body: { graphId } });
    if (r.status !== 200) throw new Error(`${this.name} could not switch: ${r.status} ${r.text}`);
  }
}

async function main() {
  const anna = new Client("Anna"), sara = new Client("Sara");
  await anna.login("anna@example.com");
  await sara.login("sara@example.com");

  const annaGraphs = (await anna.req("/api/graphs")).json.graphs as { id: string; name: string; kind: string; myRole: string }[];
  const fam = annaGraphs.find((g) => g.kind === "family")!, work = annaGraphs.find((g) => g.name === "Work")!, forSara = annaGraphs.find((g) => g.name === "For Sara")!;
  ok(fam && work && forSara, "Anna is in Family, Work and For Sara");

  // ── Anna adds recognisable content to Family and Work.
  const stamp = Date.now().toString(36);
  const FAM = `Zebrafamily${stamp}`, WORK = `Zebrawork${stamp}`;
  await anna.switchTo(fam.id);
  const famNode = (await anna.req("/api/nodes", { method: "POST", body: { type: "event", label: `${FAM} birthday`, visibility: "household", startAt: new Date(Date.now() + 3 * 86400e3).toISOString() } })).json.node;
  const famPerson = (await anna.req("/api/nodes", { method: "POST", body: { type: "person", label: `${FAM} Grandma`, visibility: "household" } })).json.node;
  const famPage = await anna.req("/api/wiki", { method: "POST", body: { title: `${FAM} recipes`, visibility: "household" } });
  const famSlug = famPage.json.page?.slug;
  const fd = new FormData();
  fd.append("file", new Blob([`${FAM} secret note about the family`], { type: "text/plain" }), `${FAM}.txt`);
  fd.append("visibility", "household");
  const upload = await anna.req("/api/library", { method: "POST", raw: fd });
  const famSourceId = upload.json?.sourceId ?? upload.json?.items?.[0]?.sourceId ?? upload.json?.results?.[0]?.sourceId;
  const famRem = await anna.req("/api/reminders", { method: "POST", body: { title: `${FAM} dentist`, dueAt: new Date(Date.now() + 2 * 86400e3).toISOString() } });
  ok(famNode?.id && famPerson?.id && famSlug && famRem.status < 300, `family content created (upload ${upload.status})`);

  await anna.switchTo(work.id);
  const workNode = (await anna.req("/api/nodes", { method: "POST", body: { type: "topic", label: `${WORK} roadmap`, visibility: "household" } })).json.node;
  ok(workNode?.id, "work content created");

  // Anna in Work sees only Work.
  let g = await anna.req("/api/graph");
  ok(g.text.includes(WORK) && !g.text.includes(FAM) && !g.text.includes("Weekend in Skagen"), "Anna in Work: graph shows only Work");
  ok(!(await anna.req(`/api/nodes/${famNode.id}`)).text.includes(FAM), "Anna in Work: family node by id is not found");
  ok(!(await anna.req("/api/timeline")).text.includes(FAM), "Anna in Work: timeline has no family events");
  ok(!(await anna.req("/api/wiki")).text.includes(FAM), "Anna in Work: wiki has no family pages");
  ok(!(await anna.req("/api/library")).text.includes(FAM), "Anna in Work: library has no family files");

  await anna.switchTo(forSara.id);
  g = await anna.req("/api/graph");
  ok(g.text.includes("Weekend in Skagen") && !g.text.includes(WORK) && !g.text.includes(FAM) && !g.text.includes("Mikkel"), "Anna in For Sara: graph shows only For Sara");

  await anna.switchTo(fam.id);
  g = await anna.req("/api/graph");
  ok(g.text.includes(FAM) && !g.text.includes(WORK) && !g.text.includes("Weekend in Skagen"), "Anna in Family: graph shows only Family");

  // ── Sara.
  const saraGraphs = (await sara.req("/api/graphs")).json.graphs as { id: string; name: string }[];
  ok(saraGraphs.length === 2 && saraGraphs.some((x) => x.id === forSara.id) && saraGraphs.some((x) => x.name === "Personal"), `Sara's graphs: ${saraGraphs.map((x) => x.name).join(", ")}`);
  ok((await sara.req("/api/graphs/switch", { method: "POST", body: { graphId: fam.id } })).status === 404, "Sara can't switch to Anna's Family graph");
  ok((await sara.req("/api/graphs/switch", { method: "POST", body: { graphId: work.id } })).status === 404, "Sara can't switch to Anna's Work graph");
  ok((await sara.req(`/api/graphs/${fam.id}/members`)).status === 404, "Sara can't list Family members");
  // A forged cookie for the family graph falls back to a graph she's in.
  sara.jar.set("mg_graph", fam.id);
  ok(!(await sara.req("/api/graph")).text.includes(FAM), "forged mg_graph cookie is ignored");
  await sara.switchTo(forSara.id);

  const MARKERS = [FAM, WORK, "Mikkel", "Noah", "Old note", "Old page", "Old reminder", "Old chat", "Emma starts swimming", "Quarterly planning"];
  const clean = (text: string) => MARKERS.filter((m) => text.includes(m));
  const ids = [famNode.id, famPerson.id, workNode.id];
  const check = async (label: string, path: string, init?: Parameters<Client["req"]>[1]) => {
    const r = await sara.req(path, init);
    const leaked = clean(r.text).concat(ids.filter((id) => r.text.includes(id)));
    ok(leaked.length === 0 && r.status < 500, `Sara ${label} (${r.status})${leaked.length ? ` LEAKED ${leaked.join(", ")}` : ""}`);
    return r;
  };
  const sg = await check("graph view", "/api/graph");
  ok(sg.text.includes("Weekend in Skagen"), "Sara sees For Sara content");
  await check("nodes search", `/api/nodes?q=${FAM}`);
  await check("nodes list", "/api/nodes?limit=500");
  await check("nodes by name Emma", "/api/nodes?q=Emma");
  await check("timeline", "/api/timeline");
  await check("people", "/api/people");
  await check("library", "/api/library");
  await check("library search", `/api/library?q=${FAM}`);
  await check("wiki list", "/api/wiki");
  await check("wiki search", `/api/wiki?q=${FAM}`);
  await check("reminders", "/api/reminders");
  await check("merge suggestions", "/api/nodes/merge-suggestions");
  await check("meta model", "/api/meta");
  await check("conversations", "/api/chat");
  for (const id of ids) {
    const r = await check(`node ${id.slice(0, 8)} by id`, `/api/nodes/${id}`);
    ok(r.status === 404, `Sara gets 404 for a family/work node (${r.status})`);
    ok((await sara.req(`/api/people/${id}`)).status === 404, "…and from the people API");
  }
  if (famSlug) {
    const r = await check("family wiki page by slug", `/api/wiki/${famSlug}`);
    ok(r.status === 404, `Sara gets 404 for the family wiki page (${r.status})`);
  }
  if (famSourceId) {
    ok((await check("family file by id", `/api/library/${famSourceId}`)).status === 404, "Sara gets 404 for the family file");
    ok((await sara.req(`/api/files/${famSourceId}`)).status === 404, "…and its download");
  } else ok(false, `family upload id missing: ${upload.text.slice(0, 200)}`);
  // Chat: the context it retrieves (and cites) comes from For Sara only.
  const chat = await check("chat answer and citations", "/api/chat", { method: "POST", body: { question: "Tell me about Grandma, the upcoming birthday, the recipes, the dentist and the secret note about the family." } });
  ok(chat.status === 200, "chat answered");
  // Control: the same question from Anna in Family does find the family content, so the check above means something.
  await anna.switchTo(fam.id);
  const control = await anna.req("/api/chat", { method: "POST", body: { question: "Tell me about Grandma, the upcoming birthday, the recipes, the dentist and the secret note about the family." } });
  ok(control.text.includes(FAM), "control: Anna in Family gets the family content in chat context");
  const chat2 = await check("chat about the trip", "/api/chat", { method: "POST", body: { question: "When is the weekend in Skagen?" } });
  ok(/Skagen/.test(chat2.text), "chat can use For Sara content");

  // Writes: Sara (editor) adds to For Sara, but can't connect to Family.
  const saraNode = (await sara.req("/api/nodes", { method: "POST", body: { type: "topic", label: `Sara idea ${stamp}`, visibility: "household" } })).json.node;
  ok(saraNode?.id, "Sara (editor) can add to For Sara");
  const cross = await sara.req("/api/people/" + saraNode.id + "/relations", { method: "POST", body: { relation: "knows", direction: "out", otherId: famPerson.id } });
  ok(cross.status >= 400 && cross.status < 500, `Sara can't relate to a Family person (${cross.status})`);
  ok(!(await anna.req("/api/graph")).text.includes(`Sara idea ${stamp}`), "Anna in Family doesn't see Sara's For Sara node");

  // ── Invite flow: a brand-new person, in a household of their own.
  await anna.switchTo(forSara.id);
  const email = `newbie-${stamp}@example.com`;
  const inv = await anna.req(`/api/graphs/${forSara.id}/invites`, { method: "POST", body: { email, role: "editor" } });
  ok(inv.status === 201 && /\/invite\//.test(inv.json?.inviteUrl ?? ""), "Anna creates an invite link");
  ok((await anna.req(`/api/graphs/${fam.id}/invites`, { method: "POST", body: { email: "x@example.com" } })).status === 400, "no invites into the family graph");
  const token = String(inv.json?.inviteUrl ?? "").split("/invite/")[1];
  const pub = new Client("Newbie");
  const preview = await pub.req(`/api/invites/${token}`);
  ok(preview.json?.invite?.graphName === "For Sara" && preview.json?.invite?.hasAccount === false && !preview.text.includes("Demo family"), "public preview shows only graph, inviter and email");
  const acc = await pub.req(`/api/invites/${token}/accept`, { method: "POST", body: { name: "Newbie", password: "a-long-password-1" } });
  ok(acc.status === 200 && pub.jar.has("mg_session") && pub.jar.get("mg_graph") === forSara.id, `new account made and signed in (${acc.status})`);
  ok((await pub.req(`/api/invites/${token}/accept`, { method: "POST", body: {} })).status === 409, "an invite works once");
  const pubGraphs = (await pub.req("/api/graphs")).json.graphs as { name: string }[];
  ok(pubGraphs.map((x) => x.name).sort().join(",") === "For Sara,Personal", `newbie's graphs: ${pubGraphs.map((x) => x.name).join(", ")}`);
  ok(!(await pub.req("/api/graph")).text.includes(FAM), "newbie sees no family content");

  // Viewer can't write.
  const members = (await anna.req(`/api/graphs/${forSara.id}/members`)).json.members as { userId: string; name: string }[];
  const newbie = members.find((m) => m.name === "Newbie")!;
  ok((await anna.req(`/api/graphs/${forSara.id}/members/${newbie.userId}`, { method: "PATCH", body: { role: "viewer" } })).status === 200, "Anna makes Newbie a viewer");
  const denied = await pub.req("/api/nodes", { method: "POST", body: { type: "topic", label: "viewer wrote this" } });
  ok(denied.status === 403, `viewer can't add a node (${denied.status})`);
  ok((await pub.req("/api/wiki", { method: "POST", body: { title: "viewer page" } })).status === 403, "viewer can't add a wiki page");
  ok((await pub.req("/api/reminders", { method: "POST", body: { title: "x", dueAt: new Date(Date.now() + 86400e3).toISOString() } })).status >= 400, "viewer can't add a reminder");
  // Leaving.
  ok((await pub.req(`/api/graphs/${forSara.id}/members/${newbie.userId}`, { method: "DELETE" })).status === 200, "Newbie leaves For Sara");
  ok(!(await pub.req("/api/graph")).text.includes("Weekend in Skagen"), "after leaving, For Sara is gone for Newbie");
  ok((await anna.req(`/api/graphs/${forSara.id}/members/${(await anna.req("/api/graphs")).json.graphs.find((x: { id: string }) => x.id === forSara.id).ownerId}`, { method: "DELETE" })).status === 403, "owner can't leave their own graph");
  ok((await anna.req(`/api/graphs/${fam.id}`, { method: "DELETE" })).status === 409, "the family graph can't be archived");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll isolation checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
