import { expect, request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3917";
export const PASSWORD = process.env.E2E_PASSWORD ?? "demo-demo-demo";
/** Mutating requests need a same-origin Origin header (the middleware's CSRF check). */
export const ORIGIN = { origin: BASE };

export const USERS = {
  anna: "anna@example.com", // owner of the demo household
  mikkel: "mikkel@example.com", // parent
  emma: "emma", // child (needs device approval)
  sara: "sara@example.com", // another household
} as const;
export type Who = keyof typeof USERS;

export const authFile = (who: Who) => `e2e/.auth/${who}.json`;

/** Sign in through the API on a request context (cookies stay on it). */
export async function apiLogin(ctx: APIRequestContext, who: Who) {
  const r = await ctx.post("/api/auth/login", { data: { email: USERS[who], password: PASSWORD }, headers: ORIGIN });
  expect(r.status(), `login ${who}`).toBe(200);
  return (await r.json()) as { ok: boolean; pending?: boolean };
}

export async function apiSession(who: Who) {
  const ctx = await request.newContext({ baseURL: BASE, timeout: 120_000 });
  await apiLogin(ctx, who);
  return ctx;
}

export async function graphs(ctx: APIRequestContext | Page) {
  const req = "request" in ctx ? ctx.request : ctx;
  const r = await req.get("/api/graphs");
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as { graphs: { id: string; name: string; kind?: string; isCurrent?: boolean }[] }).graphs;
}

/** Make `name` the current graph for this page's (or request context's) cookies. */
export async function switchGraph(ctx: APIRequestContext | Page, name: string) {
  const req = "request" in ctx ? ctx.request : ctx;
  const g = (await graphs(ctx)).find((x) => x.name === name);
  if (!g) throw new Error(`No graph named ${name}`);
  const r = await req.post("/api/graphs/switch", { data: { graphId: g.id }, headers: ORIGIN });
  expect(r.status()).toBe(200);
  return g;
}

export async function setLocale(ctx: APIRequestContext | Page, locale: "en" | "da") {
  const req = "request" in ctx ? ctx.request : ctx;
  const r = await req.patch("/api/settings", { data: { locale }, headers: ORIGIN });
  expect(r.status()).toBe(200);
}

export async function setTheme(ctx: APIRequestContext | Page, theme: "light" | "dark" | "system") {
  const req = "request" in ctx ? ctx.request : ctx;
  const r = await req.patch("/api/settings", { data: { theme }, headers: ORIGIN });
  expect(r.status()).toBe(200);
}

export const uid = () => Math.random().toString(36).slice(2, 8);

/** Fails the test on uncaught page errors; collects console errors for inspection. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Wait until the client has hydrated (dev compiles lazily, so early clicks can land before React is listening). */
export async function settled(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/** The app's own words on the page: navigation, headings, buttons, labels, placeholders and aria-labels (not content). */
export function chromeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll("nav a, nav button, h1, h2, h3, button, label, [role=tab], th, [placeholder], [aria-label]")];
    return els.map((e) => [(e as HTMLElement).innerText, e.getAttribute("aria-label"), e.getAttribute("placeholder")].filter(Boolean).join(" ")).join("\n");
  });
}

/** Visible text of the page body. */
export const bodyText = (page: Page) => page.locator("body").innerText();

/** Strings that look like an untranslated message key, e.g. "chat.server.title". */
export function rawKeys(text: string): string[] {
  const hits = text.match(/(?<![\w@./:-])[a-z][a-zA-Z]+(?:\.[a-z][a-zA-Z0-9]+){2,}(?![\w/@(-])/g) ?? [];
  // file names, domains and versions are fine
  // file names and domains (pmrun.com.br, x.co.uk) are fine: their last part is a short extension or country code
  return hits.filter((h) => !/\.(?:[a-z]{2,3}|html|json|docx|pptx|xlsx|jpeg|webp)$/i.test(h) && !/^www\./.test(h));
}

export async function newContextAs(browser: { newContext: (o?: object) => Promise<BrowserContext> }, who: Who) {
  return browser.newContext({ storageState: authFile(who) });
}
