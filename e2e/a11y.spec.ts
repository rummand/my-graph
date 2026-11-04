import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { authFile, setTheme, switchGraph } from "./helpers";

test.use({ storageState: authFile("anna") });
test.describe.configure({ mode: "serial" });

const PAGES = ["/", "/chat", "/people", "/timeline", "/library", "/wiki", "/artifacts", "/graph", "/connections", "/changes",
  "/history", "/memory", "/automations", "/settings"];

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: authFile("anna") });
  await setTheme(ctx.request, "light");
  await ctx.close();
});

for (const theme of ["light", "dark"] as const) {
  for (const path of [...PAGES, "/login"]) {
    test(`axe ${theme} ${path}`, async ({ page, browser }) => {
      let target = page;
      if (path === "/login") {
        const ctx = await browser.newContext({ colorScheme: theme });
        target = await ctx.newPage();
      } else {
        await setTheme(page, theme);
        await switchGraph(page, "Family");
      }
      await target.goto(path);
      await expect(target.locator("h1").first()).toBeVisible();
      await target.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await target.waitForTimeout(600); // let entry animations settle before measuring contrast
      const results = await new AxeBuilder({ page: target as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 4).map((n) => n.target.join(" ") + " — " + (n.failureSummary ?? "").split("\n").slice(1, 2).join("")).join(" | ")}`);
      expect(summary, `${theme} ${path}`).toEqual([]);
    });
  }
}
