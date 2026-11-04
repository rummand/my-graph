import { test, expect } from "@playwright/test";
import { authFile, chromeText, rawKeys, switchGraph, watchErrors } from "./helpers";

export const MAIN_PAGES = ["/", "/chat", "/people", "/timeline", "/library", "/wiki", "/artifacts", "/graph", "/connections",
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
