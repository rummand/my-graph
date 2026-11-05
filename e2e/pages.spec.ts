import { test, expect } from "@playwright/test";
import { authFile, chromeText, rawKeys, switchGraph, watchErrors } from "./helpers";

export const MAIN_PAGES = ["/", "/chat", "/people", "/timeline", "/library", "/artifacts", "/artifacts/pages", "/artifacts/documents", "/artifacts/decks", "/artifacts/styles", "/graph", "/connections",
  "/changes", "/history", "/memory", "/automations", "/graphs", "/settings"];

test.use({ storageState: authFile("anna") });

for (const graph of ["Family", "Work"]) {
  test.describe(`every main page loads in ${graph}`, () => {
    for (const path of MAIN_PAGES) {
      test(`${graph} ${path}`, async ({ page }) => {
        await switchGraph(page, graph);
        const errors = watchErrors(page);
        const bad: string[] = [];
        page.on("response", (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`); });
        const res = await page.goto(path);
        expect(res?.status(), path).toBeLessThan(400);
        await expect(page.locator("main h1, h1").first()).toBeVisible();
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        const text = await page.locator("body").innerText();
        expect(rawKeys(text), "raw message keys").toEqual([]);
        expect(text).not.toMatch(/\{[a-z][a-zA-Z]*\}/); // unfilled {placeholders}
        expect(text).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
        // The app's own wording in a Work graph never assumes a family (account settings and the graph list may name the
        // Family graph or the household account, so those two pages are skipped).
        if (graph === "Work" && !["/graphs", "/settings"].includes(path)) {
          const lines = (await chromeText(page)).split("\n").filter((l) => /\bfamily\b|\bhousehold\b|\bchildren\b|\bkids?\b/i.test(l));
          expect(lines, "family wording in a Work graph").toEqual([]);
        }
        expect(bad).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  });
}

test.describe("old addresses", () => {
  test("the wiki and design sets moved under Artifacts", async ({ page }) => {
    await switchGraph(page, "Family");
    const index = await page.request.get("/wiki", { maxRedirects: 0 });
    expect(index.status()).toBe(308);
    expect(index.headers().location).toMatch(/\/artifacts\/pages$/);
    const list = (await (await page.request.get("/api/pages?limit=1")).json()) as { pages: { slug: string }[] };
    const old = (await (await page.request.get("/api/wiki?limit=1")).json()) as { pages: { slug: string }[] };
    expect(old.pages.map((p) => p.slug)).toEqual(list.pages.map((p) => p.slug));
    if (list.pages[0]) {
      await page.goto(`/wiki/${list.pages[0].slug}`);
      await expect(page).toHaveURL(new RegExp(`/artifacts/pages/${list.pages[0].slug}$`));
    }
    await page.goto("/artifacts/design-sets");
    await expect(page).toHaveURL(/\/artifacts\/styles$/);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/wiki/i);
  });
});
