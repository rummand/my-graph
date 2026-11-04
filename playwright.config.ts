import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the running dev server (default http://localhost:3917, override with E2E_BASE_URL).
 * They sign in through the API and use the seeded demo household (scripts/seed.ts). Run: npm run test:e2e
 * The dev server compiles routes on first use, so timeouts are generous; tests that wait on mux are tagged @slow.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3917";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-GB",
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, dependencies: ["setup"] },
  ],
});
