import { test, expect } from "@playwright/test";
import { authFile, chromeText, rawKeys, setLocale, settled, switchGraph } from "./helpers";

test.use({ storageState: authFile("anna") });

// English phrases that must not be left on Danish pages (common UI words and headings).
const ENGLISH = [/\bToday\b/, /\bSettings\b/, /\bSign out\b/, /\bWaiting for you\b/, /\bDeliver\b/, /\bPeople\b/, /\bNew page\b/,
  /\bNothing yet\b/, /\bSomething went wrong\b/, /\bLoading\b/, /\bSearch\b/, /\bShow more\b/, /\bAdd person\b/, /\bRun now\b/,
  /\bAsk anything\b/, /\bWhat changed\b/, /\bThis week\b/, /\bCancel\b/, /\bSave\b/, /\bClose\b/, /\bBack\b/];

const PAGES = ["/", "/chat", "/people", "/timeline", "/library", "/wiki", "/artifacts", "/graph", "/connections", "/changes",
  "/history", "/memory", "/automations", "/graphs", "/settings"];

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: authFile("anna") });
  await setLocale(ctx.request, "en");
  await ctx.close();
});

test("switching to Danish in Settings", async ({ page }) => {
  await page.goto("/settings"); await settled(page);
  await page.locator("label", { has: page.getByRole("radio", { name: /^Dansk/ }) }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "da");
  await expect(page.getByRole("link", { name: "Indstillinger" }).first()).toBeVisible();
});

for (const graph of ["Family", "Work"]) {
  for (const path of PAGES) {
    test(`Danish ${graph} ${path} has no English leftovers or raw keys`, async ({ page }) => {
      await setLocale(page, "da");
      await switchGraph(page, graph);
      await page.goto(path); await settled(page);
      await expect(page.locator("h1").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      // Content people wrote (names, notes, titles) can be English; check the app's own chrome and headings.
      const chrome = await chromeText(page);
      const body = await page.locator("body").innerText();
      expect(rawKeys(body), "raw keys").toEqual([]);
      const leftovers = chrome.split("\n").filter((line) => ENGLISH.some((re) => re.test(line))).map((l) => l.slice(0, 120));
      expect(leftovers, `English in the chrome of ${path}`).toEqual([]);
    });
  }
}
