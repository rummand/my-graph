/**
 * Notion, read-only, through the household's own public integration (see oauth/providers.ts). The integration sees
 * only the pages and databases the person shared with it on Notion's consent page (or later, with "Add connections").
 *
 *   content  /search, newest edit first, back to the saved position (last_edited_time). Oldest change first:
 *            a page → one batch of its blocks (headings, lists, to-dos, tables, mentions of people and dates);
 *            a database, or a row in one → one batch of the database with all its rows (up to MAX_ROWS).
 *            The same page or database is updated in place (same source), never duplicated; unchanged bytes are not
 *            read again. Notion rounds edit times to the minute, so items in the cursor's own minute are looked at
 *            again (and recognised as unchanged).
 * The `notion` importer turns them into searchable text and proposals (people from a database that looks like a
 * contact list); nothing is written to the graph directly.
 */
import { z } from "zod";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import type { Api } from "../oauth/client";
import { account, oauthSecrets, visibility } from "../oauth/fields";
import { NOTION_GRAPH_KINDS } from "@/lib/importers/notion";
import type { NotionBlock } from "@/lib/importers/notion/schema";
import { notionCall, type NotionList } from "./api";
import { databasePayload, newMentions, pagePayload, readChildren, renderBlock, plain, type Mentions, type RawBlock, type RawDatabase, type RawPage } from "./render";
import type { ImportBatch } from "../slack/connector";

export const notionConfig = z.object({ visibility, account });
export type NotionConfig = z.infer<typeof notionConfig>;

export const notionManifest = defineManifest({
  id: "notion", version: "1", status: "official", icon: "note",
  graphKinds: NOTION_GRAPH_KINDS,
  auth: { type: "oauth2" },
  config: notionConfig,
  secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [{ name: "content", key: "page or database id", cursor: "last_edited_time", resetOn: [] }],
  schedule: { everyMinutes: 60 },
  // Notion allows about three requests a second on average.
  rateLimit: { perMinute: 120, backoff: "exponential" },
  maps: { content: "document" },
});

export type NotionDeps = { api: Api; base: string; importBatch: ImportBatch };
export type NotionCursor = { after?: string | null };

const MAX_SEARCH_PAGES = 10;
const MAX_ITEMS_PER_RUN = 40;
const MAX_BLOCKS = 1500;
const MAX_DEPTH = 3;
const MAX_ROWS = 1000;

type Found = RawPage | RawDatabase;

export async function syncNotion(ctx: RunContext<NotionConfig>, d: NotionDeps): Promise<void> {
  const after = cursorOf<NotionCursor>(ctx.state(), "content")?.after ?? null;
  const found: Found[] = [];
  let start: string | undefined;
  search: for (let i = 0; i < MAX_SEARCH_PAGES; i++) {
    const r = await notionCall<NotionList<Found>>(d.api, d.base, "/search", {
      sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100, ...(start ? { start_cursor: start } : {}),
    });
    if (!r) break;
    for (const x of r.results ?? []) {
      if (after && (x.last_edited_time ?? "") < after) break search;
      if (x.archived || x.in_trash) continue;
      found.push(x);
    }
    if (!r.has_more || !r.next_cursor) break;
    start = r.next_cursor;
  }
  if (!found.length) { if (!after) ctx.log("Nothing is shared with My Graph in Notion yet. In Notion, open a page, choose ••• and Connections, and add My Graph."); return; }

  // Oldest change first, so the cursor only moves forward.
  found.sort((a, b) => (a.last_edited_time ?? "").localeCompare(b.last_edited_time ?? ""));
  const done = new Set<string>();
  let left = MAX_ITEMS_PER_RUN;
  for (const x of found) {
    if (left <= 0) { ctx.log("Stopped for now; more pages come in the next run."); return; }
    const dbId = x.object === "database" ? x.id : x.parent?.type === "database_id" ? x.parent.database_id ?? null : null;
    const key = dbId ? `db:${dbId}` : `page:${x.id}`;
    if (!done.has(key)) {
      done.add(key);
      left--;
      if (dbId) await readDatabase(ctx, d, dbId, x.object === "database" ? x : null);
      else await readPage(ctx, d, x as RawPage);
    }
    await ctx.commit("content", { after: x.last_edited_time ?? after } satisfies NotionCursor, async () => {});
  }
}

/** Blocks of a page (or block), depth first, within the caps. */
export async function readBlocks(d: NotionDeps, id: string, depth: number, m: Mentions, out: NotionBlock[]): Promise<void> {
  let start: string | undefined;
  for (let i = 0; i < 20 && out.length < MAX_BLOCKS; i++) {
    const r = await notionCall<NotionList<RawBlock>>(d.api, d.base, `/blocks/${encodeURIComponent(id)}/children?page_size=100${start ? `&start_cursor=${encodeURIComponent(start)}` : ""}`);
    if (!r) return;
    for (const b of r.results ?? []) {
      if (out.length >= MAX_BLOCKS) return;
      const t = renderBlock(b, depth, m);
      if (t) out.push(t);
      if (readChildren(b) && depth < MAX_DEPTH) await readBlocks(d, b.id, depth + 1, m, out);
    }
    if (!r.has_more || !r.next_cursor) return;
    start = r.next_cursor;
  }
}

async function readPage(ctx: RunContext<NotionConfig>, d: NotionDeps, p: RawPage): Promise<void> {
  const m = newMentions();
  const blocks: NotionBlock[] = [];
  await readBlocks(d, p.id, 0, m, blocks);
  ctx.count("content", "fetched");
  const payload = pagePayload(p, blocks, m);
  const r = await d.importBatch({ bytes: new TextEncoder().encode(JSON.stringify(payload)), title: `Notion: ${payload.page.title}`.slice(0, 250), externalId: `notion:page:${p.id}` });
  ctx.count("content", r.duplicate ? "unchanged" : "added");
}

async function readDatabase(ctx: RunContext<NotionConfig>, d: NotionDeps, id: string, known: RawDatabase | null): Promise<void> {
  const db = known ?? await notionCall<RawDatabase>(d.api, d.base, `/databases/${encodeURIComponent(id)}`);
  if (!db) { ctx.log("A Notion database is no longer shared with My Graph; it was skipped."); ctx.count("content", "skipped"); return; }
  const rows: RawPage[] = [];
  let start: string | undefined;
  for (let i = 0; i < Math.ceil(MAX_ROWS / 100); i++) {
    const r = await notionCall<NotionList<RawPage>>(d.api, d.base, `/databases/${encodeURIComponent(id)}/query`, { page_size: 100, ...(start ? { start_cursor: start } : {}) });
    if (!r) break;
    rows.push(...(r.results ?? []).filter((x) => !x.archived && !x.in_trash));
    if (!r.has_more || !r.next_cursor) break;
    start = r.next_cursor;
  }
  if (rows.length >= MAX_ROWS) ctx.log(`"${plain(db.title) || "A Notion database"}" has more than ${MAX_ROWS} rows; the first ${MAX_ROWS} were read.`);
  ctx.count("content", "fetched");
  const payload = databasePayload(db, rows);
  const r = await d.importBatch({ bytes: new TextEncoder().encode(JSON.stringify(payload)), title: `Notion: ${payload.database.title}`.slice(0, 250), externalId: `notion:db:${id}` });
  ctx.count("content", r.duplicate ? "unchanged" : "added");
}
