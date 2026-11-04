import { test, expect } from "@playwright/test";
import { authFile, PASSWORD, settled, USERS, watchErrors } from "./helpers";

test.describe("sign-in", () => {
  test("signs in with the form and signs out", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await settled(page);
    await page.getByLabel("Email or username").or(page.getByLabel("Email")).first().fill(USERS.anna);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(401);
    expect(errors).toEqual([]);
  });

  test("a wrong password is refused with a message", async ({ page }) => {
    await page.goto("/login");
    await settled(page);
    await page.getByLabel("Email or username").or(page.getByLabel("Email")).first().fill(USERS.anna);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("graph switching", () => {
  test.use({ storageState: authFile("anna") });
  test("switches from Family to Work in the header", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      if (!(await dialog.isVisible())) await page.getByRole("button", { name: /Working in Family/ }).first().click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass();
    await dialog.getByRole("button", { name: /^Work/ }).click();
    await expect.poll(async () => (await (await page.request.get("/api/auth/me")).json()).me?.graph?.name).toBe("Work");
    await page.reload();
    await expect(page.getByRole("button", { name: /Working in Work/ }).first()).toBeVisible();
    await expect.poll(async () => (await (await page.request.get("/api/auth/me")).json()).me?.graph?.name).toBe("Work");
  });
});
