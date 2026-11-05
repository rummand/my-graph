/**
 * The JSON batches the Notion connector keeps as library sources (pure, shared with src/lib/connectors/notion):
 * one page rendered to blocks of text, or one database with its rows. (A Notion workspace export .zip is another
 * importer, `notion_export`.)
 */
import { z } from "zod";

const text = (max: number) => z.string().max(max);
const iso = z.string().max(40);

export const notionPerson = z.object({ id: text(80), name: text(200), email: text(320).optional() });
export type NotionPerson = z.infer<typeof notionPerson>;

export const notionBlock = z.object({
  id: text(80),
  type: z.enum(["heading", "text", "list", "todo", "quote", "code", "table", "child", "divider"]),
  /** 1–3 for headings. */
  level: z.number().int().min(1).max(3).optional(),
  /** How deep in toggles and nested lists. */
  depth: z.number().int().min(0).max(10).default(0),
  text: text(20_000),
  checked: z.boolean().optional(),
});
export type NotionBlock = z.infer<typeof notionBlock>;

const mentions = z.object({
  people: z.array(notionPerson).max(500).default([]),
  dates: z.array(z.object({ start: iso, end: iso.nullish() })).max(500).default([]),
});

export const notionValue = z.object({ name: text(200), type: text(40), value: text(4000) });

export const notionPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    page: z.object({ id: text(80), title: text(2000), url: text(2000).optional(), createdAt: iso.optional(), lastEdited: iso.optional(), createdBy: notionPerson.optional() }),
    /** The page's own properties, when it has more than a title. */
    values: z.array(notionValue).max(200).default([]),
    blocks: z.array(notionBlock).max(5_000),
    mentions: mentions.default({ people: [], dates: [] }),
  }),
  z.object({
    kind: z.literal("database"),
    database: z.object({ id: text(80), title: text(2000), url: text(2000).optional(), lastEdited: iso.optional() }),
    properties: z.array(z.object({ name: text(200), type: text(40) })).max(200),
    rows: z.array(z.object({
      id: text(80), title: text(2000), url: text(2000).optional(), lastEdited: iso.optional(),
      values: z.array(notionValue).max(200),
      emails: z.array(text(320)).max(20).default([]),
      phones: z.array(text(80)).max(20).default([]),
    })).max(2_000),
  }),
]);
export type NotionPayload = z.infer<typeof notionPayload>;
export type NotionPagePayload = Extract<NotionPayload, { kind: "page" }>;
export type NotionDatabasePayload = Extract<NotionPayload, { kind: "database" }>;
