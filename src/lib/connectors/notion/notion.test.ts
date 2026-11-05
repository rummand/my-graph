import { describe, expect, it } from "vitest";
import { cursorOf } from "../state";
import { fakeApi, fakeCtx } from "../oauth/testing";
import { apiBase, buildAuthorizeUrl, providerInfo } from "../oauth/providers";
import { tokenRequest } from "../oauth/tokens";
import type { HttpRequest } from "@/lib/mcp-client/transport";
import { looksLikePeople, notionApiImporter } from "@/lib/importers/notion";
import type { ImportContext } from "@/lib/importers/types";
import type { ImportBatch } from "../slack/connector";
import { notionConfig, syncNotion, type NotionCursor } from "./connector";
import { newMentions, propertyText, renderBlock } from "./render";

const BASE = apiBase({ NODE_ENV: "test" }).notion;
const NOW = new Date("2026-11-04T10:00:00Z");
const rt = (s: string) => [{ type: "text", plain_text: s }];
const anna = { object: "user", id: "u-anna", type: "person", name: "Anna Holm", person: { email: "anna@acme.dk" } };

const PAGE = {
  object: "page", id: "p1", url: "https://www.notion.so/p1", created_time: "2026-10-01T08:00:00.000Z", last_edited_time: "2026-11-02T10:00:00.000Z",
  parent: { type: "workspace" }, properties: { title: { type: "title", title: rt("Kickoff notes") } },
};
const ROW = (id: string, name: string, email: string, edited: string) => ({
  object: "page", id, last_edited_time: edited, parent: { type: "database_id", database_id: "db1" },
  properties: { Name: { type: "title", title: rt(name) }, Email: { type: "email", email }, Role: { type: "rich_text", rich_text: rt("Engineer") } },
});
const DB = { object: "database", id: "db1", title: rt("Team"), last_edited_time: "2026-10-20T10:00:00.000Z", properties: { Name: { type: "title" }, Email: { type: "email" }, Role: { type: "rich_text" } } };

const BLOCKS: Record<string, unknown[]> = {
  p1: [
    { id: "b1", type: "heading_2", heading_2: { rich_text: rt("Plan") } },
    { id: "b2", type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "Ask " }, { type: "mention", plain_text: "@Anna Holm", mention: { type: "user", user: anna } }, { type: "text", plain_text: " by " }, { type: "mention", plain_text: "November 20, 2026", mention: { type: "date", date: { start: "2026-11-20" } } }] } },
    { id: "b3", type: "to_do", to_do: { rich_text: rt("Book room"), checked: true }, has_children: true },
    { id: "b4", type: "child_page", child_page: { title: "Sub page" }, has_children: true },
  ],
  b3: [{ id: "b5", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt("Ask facilities") } }],
};

function notionServer(results: unknown[]) {
  return fakeApi(({ u, method, body, headers }) => {
    expect(headers?.["notion-version"]).toBe("2022-06-28");
    const path = u.pathname.replace(/^\/v1/, "");
    if (path === "/search" && method === "POST") return { json: { results, has_more: false } };
    const kids = path.match(/^\/blocks\/([^/]+)\/children$/);
    if (kids) {
      if (kids[1] === "b4") throw new Error("child pages are not read as blocks");
      return { json: { results: BLOCKS[kids[1]] ?? [], has_more: false } };
    }
    if (path === "/databases/db1") return { json: DB };
    if (path === "/databases/db1/query" && method === "POST") {
      expect(JSON.parse(String(body))).toMatchObject({ page_size: 100 });
      return { json: { results: [ROW("r1", "Anna Holm", "anna@acme.dk", "2026-11-01T09:00:00.000Z"), ROW("r2", "Carl Dahl", "carl@acme.dk", "2026-11-03T09:00:00.000Z")], has_more: false } };
    }
    if (path === "/pages/gone/x") return { status: 404 };
    return undefined;
  });
}

function recorder() {
  const batches: { title: string; externalId: string; json: Record<string, unknown> }[] = [];
  const seen = new Map<string, string>();
  const importBatch: ImportBatch = async (b) => {
    const text = new TextDecoder().decode(b.bytes);
    const duplicate = seen.get(b.externalId) === text;
    seen.set(b.externalId, text);
    if (!duplicate) batches.push({ title: b.title, externalId: b.externalId, json: JSON.parse(text) });
    return { sourceId: "s", duplicate };
  };
  return { batches, importBatch };
}

describe("Notion rendering", () => {
  it("keeps heading levels, to-dos and collects mentioned people and dates", () => {
    const m = newMentions();
    expect(renderBlock(BLOCKS.p1[0] as never, 0, m)).toMatchObject({ type: "heading", level: 2, text: "Plan" });
    expect(renderBlock(BLOCKS.p1[1] as never, 0, m)).toMatchObject({ type: "text", text: "Ask @Anna Holm by November 20, 2026" });
    expect(renderBlock(BLOCKS.p1[2] as never, 1, m)).toMatchObject({ type: "todo", checked: true, depth: 1 });
    expect([...m.people.values()]).toEqual([{ id: "u-anna", name: "Anna Holm", email: "anna@acme.dk" }]);
    expect([...m.dates.values()]).toEqual([{ start: "2026-11-20", end: null }]);
  });
  it("writes properties as words", () => {
    expect(propertyText({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] })).toBe("a, b");
    expect(propertyText({ type: "date", date: { start: "2026-11-01", end: "2026-11-03" } })).toBe("2026-11-01 – 2026-11-03");
    expect(propertyText({ type: "people", people: [anna] })).toBe("Anna Holm");
    expect(propertyText({ type: "formula", formula: { type: "number", number: 4 } })).toBe("4");
    expect(propertyText({ type: "checkbox", checkbox: false })).toBe("No");
  });
});

describe("Notion sync", () => {
  it("reads shared pages and databases oldest change first, and moves the cursor", async () => {
    const rec = recorder();
    const ctx = fakeCtx("notion", notionConfig.parse({}), {}, NOW);
    const results = [ROW("r2", "Carl Dahl", "carl@acme.dk", "2026-11-03T09:00:00.000Z"), PAGE, ROW("r1", "Anna Holm", "anna@acme.dk", "2026-11-01T09:00:00.000Z"), DB];
    await syncNotion(ctx, { api: notionServer(results), base: BASE, importBatch: rec.importBatch });
    // The database is read once (with both rows), the page once with its nested blocks but not its child page.
    expect(rec.batches.map((b) => b.externalId)).toEqual(["notion:db:db1", "notion:page:p1"]);
    const page = rec.batches[1].json as { blocks: { text: string; depth: number }[]; mentions: { people: unknown[] } };
    expect(page.blocks.map((b) => [b.text, b.depth])).toEqual([["Plan", 0], ["Ask @Anna Holm by November 20, 2026", 0], ["Book room", 0], ["Ask facilities", 1], ["Sub page", 0]]);
    expect(page.mentions.people).toHaveLength(1);
    const db = rec.batches[0].json as { rows: { title: string; emails: string[] }[] };
    expect(db.rows.map((r) => [r.title, r.emails])).toEqual([["Anna Holm", ["anna@acme.dk"]], ["Carl Dahl", ["carl@acme.dk"]]]);
    expect(cursorOf<NotionCursor>(ctx.state(), "content")?.after).toBe("2026-11-03T09:00:00.000Z");

    // Next run: only what changed since the cursor's minute is looked at; unchanged bytes aren't sent again.
    rec.batches.length = 0;
    await syncNotion(ctx, { api: notionServer(results), base: BASE, importBatch: rec.importBatch });
    expect(rec.batches).toEqual([]);
  });

  it("says how to share pages when nothing is shared yet", async () => {
    const ctx = fakeCtx("notion", notionConfig.parse({}), {}, NOW);
    await syncNotion(ctx, { api: notionServer([]), base: BASE, importBatch: recorder().importBatch });
    expect(ctx.logs.join(" ")).toMatch(/Connections/);
  });
});

describe("Notion sign-in", () => {
  const env = { NOTION_CLIENT_ID: "cid", NOTION_CLIENT_SECRET: "sec", NODE_ENV: "test" };
  it("sends the person to Notion's page for a user-owned integration, without PKCE or scopes", () => {
    const u = new URL(buildAuthorizeUrl(providerInfo("notion", env), "notion", { redirectUri: "https://g.example/cb", state: "s", challenge: "c" }));
    expect(u.origin + u.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(u.searchParams.get("owner")).toBe("user");
    expect(u.searchParams.get("code_challenge")).toBeNull();
    expect(u.searchParams.get("scope")).toBeNull();
  });
  it("trades the code with HTTP Basic and a JSON body", async () => {
    let sent: HttpRequest | null = null;
    const a = await tokenRequest(async (r) => { sent = r; return { status: 200, headers: {}, url: r.url, body: Buffer.from(JSON.stringify({ access_token: "ntn_1", token_type: "bearer", workspace_name: "Acme" })) }; },
      providerInfo("notion", env), { grant_type: "authorization_code", code: "c", redirect_uri: "https://g.example/cb", code_verifier: "v" });
    expect(a.accessToken).toBe("ntn_1");
    expect(sent!.headers!.authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(sent!.headers!["content-type"]).toBe("application/json");
    expect(JSON.parse(String(sent!.body))).toEqual({ grant_type: "authorization_code", code: "c", redirect_uri: "https://g.example/cb" });
  });
});

function ctxFor(over: Partial<ImportContext> = {}): ImportContext {
  let n = 0;
  return { sourceId: "src1", graphKind: "work", visibility: "private", known: [], existingEdges: new Set(), now: NOW, mint: () => `n${++n}`, locale: "en", ...over };
}
const enc = (o: unknown) => Buffer.from(JSON.stringify(o));

describe("notion importer", () => {
  it("proposes the rows of a contact list as people, matched by email", () => {
    const known = [{ id: "p-anna", type: "person", kind: null, label: "Anna", aliases: [], startAt: null, props: { email: "anna@acme.dk" } }];
    const plan = notionApiImporter.read({ filename: "x", bytes: enc({ kind: "database", database: { id: "db1", title: "Team" }, properties: [{ name: "Name", type: "title" }, { name: "Email", type: "email" }], rows: [
      { id: "r1", title: "Anna Holm", values: [{ name: "Email", type: "email", value: "anna@acme.dk" }], emails: ["anna@acme.dk"] },
      { id: "r2", title: "Carl Dahl", values: [{ name: "Role", type: "rich_text", value: "Engineer" }], emails: ["carl@acme.dk"], phones: ["+45 12 34 56 78"] },
    ] }) }, ctxFor({ known })) as { changes: { op: string; label?: string; props?: Record<string, unknown> }[]; extract?: boolean; counts: Record<string, number> };
    expect(plan.changes.map((c) => c.label)).toEqual(["Carl Dahl"]);
    expect(plan.changes[0].props).toMatchObject({ email: "carl@acme.dk", phone: "+45 12 34 56 78", jobTitle: "Engineer", notionPageId: "r2" });
    expect(plan.extract).toBe(false);
    expect(plan.counts).toMatchObject({ people: 1, matched: 1 });
  });

  it("reads other databases as text for the model, proposing no people", () => {
    const db = { kind: "database", database: { id: "db2", title: "Roadmap" }, properties: [{ name: "Name", type: "title" }, { name: "Due", type: "date" }], rows: [{ id: "r1", title: "Launch", values: [{ name: "Due", type: "date", value: "2026-12-01" }] }] };
    expect(looksLikePeople(db as never)).toBe(false);
    const plan = notionApiImporter.read({ filename: "x", bytes: enc(db) }, ctxFor()) as { segments: { text: string }[]; changes: unknown[]; extract?: boolean };
    expect(plan.segments.map((s) => s.text)).toEqual(["Roadmap (1 rows)", "Launch; Due: 2026-12-01"]);
    expect(plan.changes).toEqual([]);
    expect(plan.extract).toBe(true);
  });

  it("renders a page with headings and proposes the people it mentions", () => {
    const plan = notionApiImporter.read({ filename: "x", bytes: enc({ kind: "page", page: { id: "p1", title: "Kickoff notes", createdAt: "2026-10-01T08:00:00.000Z" }, blocks: [
      { id: "b1", type: "heading", level: 2, text: "Plan" },
      { id: "b2", type: "text", text: "Ask @Anna Holm by November 20, 2026" },
      { id: "b3", type: "todo", text: "Book room", checked: true },
    ], mentions: { people: [{ id: "u-anna", name: "Anna Holm", email: "anna@acme.dk" }], dates: [{ start: "2026-11-20" }] } }) }, ctxFor()) as {
      segments: { text: string }[]; changes: { label?: string; receipt?: { quote?: string } }[]; extract?: boolean; occurredAt?: Date | null;
    };
    expect(plan.segments.map((s) => s.text)).toEqual(["# Kickoff notes", "## Plan\nAsk @Anna Holm by November 20, 2026\n[x] Book room"]);
    expect(plan.changes.map((c) => c.label)).toEqual(["Anna Holm"]);
    expect(plan.changes[0].receipt?.quote).toBe("Ask @Anna Holm by November 20, 2026");
    expect(plan.extract).toBe(true);
    expect(plan.occurredAt?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });
});
