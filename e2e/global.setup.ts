import { test as setup, expect } from "@playwright/test";
import { apiLogin, authFile, setLocale, setTheme, switchGraph, type Who } from "./helpers";

// Sign each adult in once through the API and keep the cookies as storage state. Every account starts in English,
// light theme, in a known graph, so the tests' copy checks are stable.
const start: Record<Exclude<Who, "emma">, string> = { anna: "Family", mikkel: "Family", sara: "Personal" };

for (const who of Object.keys(start) as (keyof typeof start)[]) {
  setup(`sign in ${who}`, async ({ request }) => {
    await apiLogin(request, who);
    await setLocale(request, "en");
    await setTheme(request, "light");
    await switchGraph(request, start[who]);
    const me = await request.get("/api/auth/me");
    expect(me.status()).toBe(200);
    await request.storageState({ path: authFile(who) });
  });
}
