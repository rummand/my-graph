import { test, expect, type Page } from "@playwright/test";
import { authFile, ORIGIN, settled, switchGraph, uid, watchErrors } from "./helpers";

test.use({ storageState: authFile("anna") });

type ChangeSet = { id: string; title: string; status: string; origin: string; createdAt: string; changes: { id: string; included: boolean }[] };
async function changeSets(page: Page, status = "draft"): Promise<ChangeSet[]> {
  const r = await page.request.get(`/api/changes?status=${status}&limit=50`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()).changeSets;
}

/** Wait until the assistant has finished answering. */
async function waitForAnswer(page: Page) {
  const stop = page.getByRole("button", { name: "Stop the answer" });
  await stop.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
  await stop.waitFor({ state: "detached", timeout: 240_000 });
}

test.describe("Today", () => {
  for (const graph of ["Family", "Work"]) {
    test(`Today in ${graph}`, async ({ page }) => {
      await switchGraph(page, graph);
      const errors = watchErrors(page);
      await page.goto("/"); await settled(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`Working in ${graph}`) }).first()).toBeVisible();
      const main = await page.locator("main").innerText();
      expect(main.length).toBeGreaterThan(80);
      if (graph === "Work") expect(main).not.toMatch(/\bfamily\b/i);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("Ask @slow", () => {
  test("answers a question with steps", async ({ page }) => {
    await switchGraph(page, "Family");
    const errors = watchErrors(page);
    await page.goto("/chat"); await settled(page);
    const box = page.locator("#chat-input");
    await box.click();
    await box.fill("Which reminders are still open?");
    await box.press("Enter");
    await waitForAnswer(page);
    await expect(page.getByText(/\d+ steps?/).first()).toBeVisible();
    const thread = await page.locator("main").innerText();
    expect(thread).toContain("Which reminders are still open?");
    expect(thread).not.toMatch(/mux is unreachable|couldn't reach/i);
    expect(errors).toEqual([]);
  });

  test("proposes a reminder and approving it saves it", async ({ page }) => {
    await switchGraph(page, "Family");
    const tag = uid();
    await page.goto("/chat"); await settled(page);
    await page.getByRole("button", { name: "New conversation" }).first().click().catch(() => {});
    const box = page.locator("#chat-input");
    await box.click();
    await box.fill(`Add a reminder for me: buy birthday candles ${tag}, tomorrow at 09:00.`);
    await box.press("Enter");
    await waitForAnswer(page);
    const approve = page.getByRole("button", { name: "Approve", exact: true }).last();
    const auto = page.getByText(/Saved automatically/).last();
    await expect(approve.or(auto)).toBeVisible();
    if (await approve.isVisible()) {
      await approve.click();
      await expect(page.getByRole("status").filter({ hasText: /Reminder added|Saved/ }).last()).toBeVisible();
    } else {
      test.info().annotations.push({ type: "note", description: "Reminders are on always-allow for Anna, so there was nothing to approve." });
    }
  });
});

test.describe("live highlights @slow", () => {
  test("Send in Work adds what was highlighted as a delivered change set", async ({ page }) => {
    await switchGraph(page, "Work");
    const before = new Set((await changeSets(page, "delivered")).map((c) => c.id));
    await page.goto("/chat"); await settled(page);
    const box = page.locator("#chat-input");
    await box.click();
    const who = `Ida Kjær ${uid()}`;
    await box.pressSequentially(`${who} from Platform Engineering joins the Data Mesh project next week. What do we know about it?`, { delay: 5 });
    await page.getByText("Reading what you wrote…").waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
    const addAndSend = page.getByRole("button", { name: "Add to the graph and send" });
    await expect(addAndSend).toBeVisible({ timeout: 90_000 });
    await addAndSend.click();
    await waitForAnswer(page);
    await expect.poll(async () => (await changeSets(page, "delivered")).filter((c) => !before.has(c.id)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  });
});

test.describe("library and changes @slow", () => {
  test("uploads a text file, then delivers part of its proposal and drops the rest", async ({ page }) => {
    await switchGraph(page, "Family");
    const errors = watchErrors(page);
    const tag = uid();
    const name = `e2e-note-${tag}.txt`;
    await page.goto("/library"); await settled(page);
    await page.locator('input[type="file"]').first().setInputFiles({
      name, mimeType: "text/plain",
      buffer: Buffer.from(`Emma's swimming coach is Jonas Berg ${tag}. Swimming practice is at Bellahøj Pool every Thursday at 16:30. Jonas Berg ${tag} works at Bellahøj Swim Club.`),
    });
    await expect(page.getByText(name).first()).toBeVisible();
    // Reading and extraction run in the background; the proposal shows up under Changes.
    let set: ChangeSet | undefined;
    await expect.poll(async () => {
      set = (await changeSets(page)).find((c) => c.title.includes(name));
      return !!set;
    }, { timeout: 240_000, intervals: [3000] }).toBe(true);
    expect(set!.changes.length).toBeGreaterThan(1);

    await page.goto(`/changes/${set!.id}`); await settled(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
    const boxes = page.getByRole("checkbox");
    await expect(boxes.first()).toBeVisible();
    await boxes.first().uncheck();
    await page.getByRole("button", { name: /^Deliver \d+ changes?$/ }).click();
    await expect(page.getByText(/Delivered \d+ changes?\./).first()).toBeVisible();
    await expect.poll(async () => (await (await page.request.get(`/api/changes/${set!.id}`)).json()).changeSet?.status).toBe("delivered");

    // What was left out waits in "Rest of …" — drop that one.
    let rest: ChangeSet | undefined;
    await expect.poll(async () => { rest = (await changeSets(page)).find((c) => c.title.startsWith("Rest of") && c.title.includes(name)); return !!rest; }).toBe(true);
    await page.goto(`/changes/${rest!.id}`); await settled(page);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Drop", exact: true }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: /Drop/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect.poll(async () => (await (await page.request.get(`/api/changes/${rest!.id}`)).json()).changeSet?.status).toBe("abandoned");
    expect(errors).toEqual([]);
  });

  test("the Changes list filters by status", async ({ page }) => {
    await page.goto("/changes"); await settled(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const label of ["Delivered", "Dropped", "Waiting for you"]) {
      await page.getByRole("link", { name: label, exact: true }).or(page.getByRole("button", { name: label, exact: true })).or(page.getByRole("tab", { name: label, exact: true })).first().click();
      await expect(page.locator("main")).toBeVisible();
    }
  });
});

test("History compares two moments", async ({ page }) => {
  await switchGraph(page, "Family");
  const errors = watchErrors(page);
  await page.goto("/history"); await settled(page);
  await expect(page.getByRole("heading", { name: "Compare two moments" })).toBeVisible();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.locator("main")).not.toContainText("Something went wrong");
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  expect(errors).toEqual([]);
});

test("People: add a person with how they know you", async ({ page }) => {
  await switchGraph(page, "Work");
  const name = `Test Person ${uid()}`;
  await page.goto("/people"); await settled(page);
  await page.getByRole("link", { name: "Add person" }).first().click();
  await expect(page).toHaveURL(/\/people\/new/);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  const how = page.getByRole("group", { name: "How do they know you?" });
  await how.getByRole("button", { name: "Colleague", exact: true }).click();
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
  await expect(page.locator("main")).toContainText(/Colleague|colleague/);
});

test("Wiki: create a page and edit it", async ({ page }) => {
  await switchGraph(page, "Family");
  const title = `E2E page ${uid()}`;
  await page.goto("/wiki"); await settled(page);
  await page.getByRole("link", { name: "New page" }).first().click();
  await expect(page).toHaveURL(/\/wiki\/new/);
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("button", { name: "Create and start writing" }).click();
  await expect(page).toHaveURL(/\/wiki\/[^/]+/);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type("Opening hours are 9 to 17 on weekdays.");
  await expect(page.getByText(/Saved/).first()).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(page.locator("main")).toContainText("Opening hours are 9 to 17 on weekdays.");
});

test("Memory: the Brain Keeper runs on request", async ({ page }) => {
  await switchGraph(page, "Family");
  await page.goto("/memory"); await settled(page);
  await expect(page.getByRole("heading", { name: "What the Brain Keeper did" })).toBeVisible();
  const run = page.getByRole("button", { name: "Run now" });
  await run.click();
  await expect(page.getByRole("button", { name: /Running…|Starting…/ }).or(page.getByText("Reading what happened since its last run…")).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(/Last ran/).first()).toBeVisible();
});

test("Automations: run one now", async ({ page }) => {
  await switchGraph(page, "Family");
  await page.goto("/automations"); await settled(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const run = page.getByRole("button", { name: "Run now" }).first();
  await run.click();
  await expect(page.getByText(/couldn't start/i)).toHaveCount(0);
  await expect(page.locator("main")).toBeVisible();
});

test("Connections page lists connectors", async ({ page }) => {
  await page.goto("/connections"); await settled(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText(/calendar|mail|Aula|ICS|IMAP/i);
});

test.describe("Documents @slow", () => {
  test("drafts a one-pager", async ({ page }) => {
    test.setTimeout(420_000);
    await switchGraph(page, "Work");
    await page.goto("/artifacts"); await settled(page);
    await page.getByRole("link", { name: "New document" }).first().click();
    await expect(page).toHaveURL(/\/artifacts\/new/);
    await page.getByRole("radio", { name: /^One-pager/ }).check({ force: true });
    const title = `E2E one-pager ${uid()}`;
    await page.getByRole("textbox", { name: /^Title/ }).fill(title);
    await page.getByRole("combobox", { name: /^Who or what is it about\?/ }).fill("The Data Mesh project: status and open risks");
    await page.getByRole("button", { name: "Draft it" }).click();
    await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
    await expect(page.getByText(title).first()).toBeVisible();
    const id = page.url().match(/artifacts\/([0-9a-f-]{36})/)![1];
    await expect.poll(async () => {
      const a = (await (await page.request.get(`/api/artifacts/${id}`)).json()).artifact;
      return a?.status === "drafting" ? "drafting" : a ? "done" : "missing";
    }, { timeout: 360_000, intervals: [5000] }).toBe("done");
  });
});

test("Settings: theme switch applies to the page", async ({ page }) => {
  await page.goto("/settings"); await settled(page);
  await page.locator("label", { has: page.getByRole("radio", { name: /^Dark/ }) }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("label", { has: page.getByRole("radio", { name: /^Light/ }) }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const r = await page.request.patch("/api/settings", { data: { theme: "light" }, headers: ORIGIN });
  expect(r.ok()).toBeTruthy();
});
