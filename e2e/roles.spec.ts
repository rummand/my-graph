import { test, expect, request } from "@playwright/test";
import { apiSession, authFile, BASE, ORIGIN, PASSWORD, settled, switchGraph, uid, USERS } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("a child account", () => {
  let parentsOnlyId = "";
  let householdId = "";
  let draftId = "";

  test.beforeAll(async () => {
    const anna = await apiSession("anna");
    await switchGraph(anna, "Family");
    const tag = uid();
    const a = await anna.post("/api/people", { data: { label: `Parents-only contact ${tag}`, kind: null, visibility: "parents" }, headers: ORIGIN });
    expect(a.status()).toBe(201);
    parentsOnlyId = (await a.json()).id;
    const b = await anna.post("/api/people", { data: { label: `Household contact ${tag}`, kind: null, visibility: "household" }, headers: ORIGIN });
    householdId = (await b.json()).id;
    const drafts = (await (await anna.get("/api/changes?status=draft&limit=5")).json()).changeSets;
    draftId = drafts[0]?.id ?? "";
    await anna.dispose();
  });

  test("needs a parent to approve a new device, and then sees only what children may see", async ({ browser }) => {
    const kidCtx = await browser.newContext();
    const kid = await kidCtx.newPage();
    const login = await kid.request.post("/api/auth/login", { data: { email: USERS.emma, password: PASSWORD }, headers: ORIGIN });
    expect(login.status()).toBe(200);
    const { pending } = await login.json();

    if (pending) {
      await kid.goto("/"); await settled(kid);
      await expect(kid).toHaveURL(/\/login\/pending/);
      expect((await kid.request.get("/api/auth/me")).status()).toBe(403);

      // Anna approves the device from Settings.
      const parentCtx = await browser.newContext({ storageState: authFile("anna") });
      const parent = await parentCtx.newPage();
      await parent.goto("/settings"); await settled(parent);
      const approve = parent.getByRole("button", { name: /^Approve .* for Emma$/ }).first();
      await expect(approve).toBeVisible();
      await approve.click();
      await expect(approve).toBeHidden();
      await parentCtx.close();
    }

    await expect.poll(async () => (await kid.request.get("/api/auth/me")).status()).toBe(200);
    await kid.goto("/"); await settled(kid);
    await expect(kid.getByRole("navigation", { name: "Main" })).toBeVisible();
    const nav = kid.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Memory" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Automations" })).toHaveCount(0);

    // Parents-only people stay hidden; household ones show.
    expect((await kid.request.get(`/api/people/${parentsOnlyId}`)).status()).toBe(404);
    expect((await kid.request.get(`/api/people/${householdId}`)).status()).toBe(200);
    const people = JSON.stringify(await (await kid.request.get("/api/people")).json());
    expect(people).not.toContain(parentsOnlyId);
    await kid.goto(`/node/${parentsOnlyId}`); await settled(kid);
    await expect(kid.locator("main")).not.toContainText("Parents-only contact");

    // Pages and actions that are for parents.
    for (const path of ["/memory", "/automations"]) {
      await kid.goto(path); await settled(kid);
      await expect(kid.locator("main")).not.toContainText(/What the Brain Keeper did|Run now/);
    }
    expect((await kid.request.get("/api/memory")).status()).toBeGreaterThanOrEqual(400);
    expect((await kid.request.get("/api/recipes")).status()).toBeGreaterThanOrEqual(400);
    if (draftId) {
      const d = await kid.request.post(`/api/changes/${draftId}/deliver`, { data: {}, headers: ORIGIN });
      expect([403, 404]).toContain(d.status());
    }
    await kidCtx.close();
  });
});

test.describe("isolation between households", () => {
  test("Sara cannot open Anna's things", async () => {
    const anna = await apiSession("anna");
    await switchGraph(anna, "Family");
    const people = (await (await anna.get("/api/people")).json());
    const ids: string[] = JSON.stringify(people).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)?.slice(0, 5) ?? [];
    const lib = await (await anna.get("/api/library")).json();
    const sourceId: string | undefined = (lib.items ?? lib.sources ?? [])[0]?.id;
    const drafts = (await (await anna.get("/api/changes?status=all&limit=3")).json()).changeSets;
    const annaGraphs = (await (await anna.get("/api/graphs")).json()).graphs as { id: string; name: string }[];
    await anna.dispose();

    const sara = await request.newContext({ baseURL: BASE });
    expect((await sara.post("/api/auth/login", { data: { email: USERS.sara, password: PASSWORD }, headers: ORIGIN })).status()).toBe(200);
    for (const id of ids) {
      expect((await sara.get(`/api/nodes/${id}`)).status(), `node ${id}`).toBeGreaterThanOrEqual(400);
      expect((await sara.get(`/api/people/${id}`)).status(), `person ${id}`).toBeGreaterThanOrEqual(400);
    }
    if (sourceId) {
      expect((await sara.get(`/api/library/${sourceId}`)).status()).toBeGreaterThanOrEqual(400);
      expect((await sara.get(`/api/files/${sourceId}`)).status()).toBeGreaterThanOrEqual(400);
    }
    for (const c of drafts) expect((await sara.get(`/api/changes/${c.id}`)).status()).toBeGreaterThanOrEqual(400);
    const family = annaGraphs.find((g) => g.name === "Family")!;
    expect((await sara.post("/api/graphs/switch", { data: { graphId: family.id }, headers: ORIGIN })).status()).toBe(404);
    // Without an Origin header a write is refused (CSRF check).
    expect((await sara.patch("/api/settings", { data: { theme: "dark" } })).status()).toBe(403);
    await sara.dispose();
  });
});
