import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/messages/en/apps";
import da from "@/lib/i18n/messages/da/apps";
import { mcpConfig } from "./config";
import {
  APP_CATEGORIES, APP_NOTES, DIRECTORY, appById, appsFor, categoriesOf, filterApps, isConnectionOf, serverUrlFor,
} from "./directory";

const https = (u: string) => {
  const url = new URL(u.replace("{instance}", "example.com"));
  return url.protocol === "https:" && !url.username && !url.password;
};

describe("apps directory entries", () => {
  it("has unique ids that fit the config's directoryId", () => {
    const ids = DIRECTORY.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it("uses https addresses, known categories and notes, and names where it was checked", () => {
    for (const a of DIRECTORY) {
      expect(https(a.serverUrl), a.id).toBe(true);
      if (a.readOnlyUrl) expect(https(a.readOnlyUrl), a.id).toBe(true);
      if (a.euUrl) expect(https(a.euUrl), a.id).toBe(true);
      expect(https(a.docsUrl), a.id).toBe(true);
      expect(APP_CATEGORIES).toContain(a.category);
      for (const n of a.notes) expect(APP_NOTES).toContain(n);
      expect(["oauth", "key", "none"]).toContain(a.auth);
      expect(a.name.trim()).not.toBe("");
      expect(a.vendor.trim()).not.toBe("");
      // Only own-server entries carry a placeholder.
      expect(a.serverUrl.includes("{instance}"), a.id).toBe(a.notes.includes("ownServer"));
    }
  });

  it("describes every app in English and Danish, with a key hint where a key works", () => {
    const enE = en.entries as Record<string, { does: string; key?: string }>;
    const daE = da.entries as Record<string, { does: string; key?: string }>;
    for (const a of DIRECTORY) {
      expect(enE[a.id]?.does, a.id).toBeTruthy();
      expect(daE[a.id]?.does, a.id).toBeTruthy();
      if (a.auth === "key" && !a.notes.includes("ownServer")) expect(enE[a.id]?.key, a.id).toBeTruthy();
      if (enE[a.id]?.key) expect(daE[a.id]?.key, a.id).toBeTruthy();
    }
    expect(Object.keys(enE).sort()).toEqual(DIRECTORY.map((a) => a.id).sort());
    for (const c of APP_CATEGORIES) {
      expect((en.categories as Record<string, string>)[c]).toBeTruthy();
      expect((da.categories as Record<string, string>)[c]).toBeTruthy();
    }
  });

  it("is a large enough directory with a Danish service", () => {
    expect(DIRECTORY.length).toBeGreaterThanOrEqual(40);
    expect(DIRECTORY.some((a) => a.region === "dk")).toBe(true);
  });
});

describe("filtering", () => {
  it("filters by category, Danish, and search words over name, vendor and description", () => {
    expect(filterApps(DIRECTORY, { category: "money" }).every((a) => a.category === "money")).toBe(true);
    expect(filterApps(DIRECTORY, { category: "dk" }).map((a) => a.id)).toEqual(["pleo"]);
    expect(filterApps(DIRECTORY, { query: "miro" }).map((a) => a.id)).toEqual(["miro"]);
    expect(filterApps(DIRECTORY, { query: "ATLASSIAN" }).map((a) => a.id).sort()).toEqual(["atlassian", "trello"]);
    const describe = (a: { id: string }) => (en.entries as Record<string, { does: string }>)[a.id]!.does;
    expect(filterApps(DIRECTORY, { query: "sticky notes" }, describe).map((a) => a.id)).toEqual(["miro"]);
    expect(filterApps(DIRECTORY, { query: "  " }).length).toBe(DIRECTORY.length);
    expect(filterApps(DIRECTORY, { category: "life", query: "nothing-like-this" })).toEqual([]);
  });

  it("ignores accents when searching", () => {
    const apps = [{ ...DIRECTORY[0]!, id: "x", name: "Ærø Café" }];
    expect(filterApps(apps, { query: "cafe" }).length).toBe(1);
  });

  it("keeps developer tools out of a family graph", () => {
    expect(appsFor("family").some((a) => a.category === "dev")).toBe(false);
    expect(appsFor("work").some((a) => a.category === "dev")).toBe(true);
    expect(categoriesOf(appsFor("family"))).not.toContain("dev");
  });
});

describe("connecting", () => {
  it("uses the read-only address unless writes are allowed, and the EU one when asked", () => {
    const linear = appById("linear")!;
    expect(serverUrlFor(linear)).toBe(linear.readOnlyUrl);
    expect(serverUrlFor(linear, { allowWrites: true })).toBe(linear.serverUrl);
    const intercom = appById("intercom")!;
    expect(serverUrlFor(intercom)).toBe(intercom.serverUrl);
    expect(serverUrlFor(intercom, { eu: true })).toBe(intercom.euUrl);
    expect(serverUrlFor(appById("n8n")!)).toBe("");
  });

  it("marks a connection with the directory id, which the config keeps", () => {
    const cfg = mcpConfig.parse({ serverUrl: "https://mcp.miro.com/", directoryId: "miro" });
    expect(cfg.directoryId).toBe("miro");
    expect(isConnectionOf(cfg, appById("miro")!)).toBe(true);
    expect(isConnectionOf(cfg, appById("canva")!)).toBe(false);
    expect(mcpConfig.safeParse({ serverUrl: "https://x.example/mcp", directoryId: "Bad Id!" }).success).toBe(false);
    expect(appById("nope")).toBeNull();
    expect(appById(42)).toBeNull();
  });
});
