import { describe, expect, it } from "vitest";
import {
  humanizeKey, interpolate, lookup, makeT, mergeDictionaries, negotiate, resolveLocale, themeAttribute,
  type Dictionary, type MessageTree,
} from "./core";
import { dateLocale, formatAgo, formatDate, isTimeZone } from "./dates";
import { DICTIONARIES } from "./messages";
import { settingsBody } from "./settings-body";

const en: Dictionary = {
  today: { title: "Today", greet: "Hello {name}", items: { one: "{count} item", other: "{count} items" }, onlyEn: "Only English" },
  shell: { nav: { people: "People" } },
};
const da: Dictionary = {
  today: { title: "I dag", greet: "Hej {name}", items: { one: "{count} ting", other: "{count} ting" } },
  shell: { nav: {} },
};

describe("locale negotiation", () => {
  it("picks the best of ours by quality", () => {
    expect(negotiate("da-DK,da;q=0.9,en;q=0.8")).toBe("da");
    expect(negotiate("en-US,en;q=0.9")).toBe("en");
    expect(negotiate("fr-FR,fr;q=0.9,da;q=0.5,en;q=0.4")).toBe("da");
    expect(negotiate("en;q=0.2, da;q=0.8")).toBe("da");
  });
  it("ignores q=0 and unknown languages", () => {
    expect(negotiate("da;q=0, en;q=0.1")).toBe("en");
    expect(negotiate("fr, de")).toBeNull();
    expect(negotiate("")).toBeNull();
    expect(negotiate(null)).toBeNull();
  });
  it("prefers the user's setting, then the cookie, then the browser, then English", () => {
    expect(resolveLocale({ user: "da", cookie: "en", acceptLanguage: "en" })).toBe("da");
    expect(resolveLocale({ user: null, cookie: "da", acceptLanguage: "en" })).toBe("da");
    expect(resolveLocale({ user: "xx", cookie: "zz", acceptLanguage: "da-DK" })).toBe("da");
    expect(resolveLocale({})).toBe("en");
  });
});

describe("translation", () => {
  const tDa = makeT("da", da, en);
  const tEn = makeT("en", en, en);
  it("looks up dotted keys and interpolates", () => {
    expect(tDa("today.title")).toBe("I dag");
    expect(tDa("today.greet", { name: "Sara" })).toBe("Hej Sara");
    expect(tEn("shell.nav.people")).toBe("People");
  });
  it("falls back from Danish to English key by key", () => {
    expect(tDa("today.onlyEn")).toBe("Only English");
    expect(tDa("shell.nav.people")).toBe("People");
  });
  it("uses the caller's fallback, else a readable key, never the raw key", () => {
    expect(tDa("today.missing", { n: 2 }, "Missing {n}")).toBe("Missing 2");
    expect(tDa("today.lastSeenAt")).toBe("Last seen at");
    expect(tDa("nope")).toBe("Nope");
    expect(tDa("today")).toBe("Today"); // a group, not a message
  });
  it("picks plural forms by count", () => {
    expect(tEn("today.items", { count: 1 })).toBe("1 item");
    expect(tEn("today.items", { count: 3 })).toBe("3 items");
    expect(tDa("today.items", { count: 3 })).toBe("3 ting");
  });
  it("leaves unknown placeholders alone", () => {
    expect(interpolate("Hi {name} {x}", { name: "A" })).toBe("Hi A {x}");
  });
  it("merges Danish over English for the client", () => {
    const m = mergeDictionaries(en, da);
    expect(lookup(m, "today.title")).toBe("I dag");
    expect(lookup(m, "today.onlyEn")).toBe("Only English");
    expect(lookup(m, "shell.nav.people")).toBe("People");
  });
  it("humanizes keys", () => {
    expect(humanizeKey("a.b.signOut_now")).toBe("Sign out now");
  });
});

describe("dictionaries", () => {
  const NS = ["common", "shell", "settings", "auth", "today", "people", "timeline", "chat", "library", "wiki", "graph", "changes",
    "history", "memory", "automations", "connections", "graphs", "onboarding", "model", "mention"];
  it("ship every namespace in both languages", () => {
    for (const ns of NS) {
      expect(DICTIONARIES.en[ns], `en.${ns}`).toBeTypeOf("object");
      expect(DICTIONARIES.da[ns], `da.${ns}`).toBeTypeOf("object");
    }
  });
  it("have no Danish keys that English lacks (a typo would never show)", () => {
    const keys = (t: MessageTree, p = ""): string[] => Object.entries(t).flatMap(([k, v]) =>
      typeof v === "string" || ("one" in v && "other" in v) ? [p + k] : keys(v as MessageTree, `${p}${k}.`));
    const enKeys = new Set(Object.entries(DICTIONARIES.en).flatMap(([ns, t]) => keys(t, `${ns}.`)));
    const extra = Object.entries(DICTIONARIES.da).flatMap(([ns, t]) => keys(t, `${ns}.`)).filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });
  it("translate the shell into Danish", () => {
    const t = makeT("da", DICTIONARIES.da, DICTIONARIES.en);
    expect(t("shell.nav.today")).toBe("I dag");
    expect(t("shell.nav.settings")).toBe("Indstillinger");
  });
});

describe("theme attribute", () => {
  it("is absent for system and set for light and dark", () => {
    expect(themeAttribute("system")).toBeUndefined();
    expect(themeAttribute("dark")).toBe("dark");
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("purple")).toBeUndefined();
    expect(themeAttribute(null)).toBeUndefined();
  });
});

describe("settings body", () => {
  it("accepts known values and rejects the rest", () => {
    expect(settingsBody.safeParse({ locale: "da" }).success).toBe(true);
    expect(settingsBody.safeParse({ theme: "dark", timeZone: "Europe/Copenhagen" }).success).toBe(true);
    expect(settingsBody.safeParse({ locale: "fr" }).success).toBe(false);
    expect(settingsBody.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(settingsBody.safeParse({}).success).toBe(false);
    expect(settingsBody.safeParse({ locale: "en", role: "owner" }).success).toBe(false);
  });
});

describe("dates", () => {
  const d = new Date("2026-03-05T23:30:00Z");
  const now = new Date("2026-06-01T12:00:00Z");
  it("formats in the reader's zone and language", () => {
    expect(formatDate(d, "date", { locale: "en", timeZone: "Europe/Copenhagen", now })).toBe("6 Mar");
    expect(formatDate(d, "date", { locale: "en", timeZone: "UTC", now })).toBe("5 Mar");
    expect(formatDate(d, "date", { locale: "da", timeZone: "Europe/Copenhagen", now })).toBe("6. mar.");
    expect(formatDate(d, "time", { locale: "en", timeZone: "Europe/Copenhagen" })).toBe("00:30");
    expect(formatDate(d, "date", { locale: "en", timeZone: "UTC", now: new Date("2027-01-01") })).toBe("5 Mar 2026");
  });
  it("knows time zones and date-fns locales", () => {
    expect(isTimeZone("Europe/Copenhagen")).toBe(true);
    expect(isTimeZone("Nowhere/Land")).toBe(false);
    expect(dateLocale("da").code).toBe("da");
    expect(dateLocale("en").code).toBe("en-GB");
  });
  it("says how long ago", () => {
    expect(formatAgo(new Date(now.getTime() - 5_000), "en", now)).toBe("just now");
    expect(formatAgo(new Date(now.getTime() - 3 * 60_000), "en", now)).toBe("3 minutes ago");
    expect(formatAgo(new Date(now.getTime() - 3 * 60_000), "da", now)).toBe("3 minutter siden");
  });
});
