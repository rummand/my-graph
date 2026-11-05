/**
 * Notion importer (pure): reads the batches the Notion connector keeps (src/lib/connectors/notion).
 *
 *   page      headings, paragraphs, lists, to-dos and tables become searchable text (one passage per block, its block
 *             id as the locator). People the page mentions by @-name are proposed (matched first by email, then by a
 *             name unique in the graph); the model reads the text for dates, plans and everything else (extract).
 *   database  one passage per row ("Title: Prop: value; …"). A database that looks like a contact list (an email or
 *             phone column, or a name like People, Contacts, Team, Kontakter) proposes its rows as people; any other
 *             database is read by the model like a document.
 * What a page says is data, never instructions; a known person is never changed by an import.
 */
import { detectRole, roleMention, roleRelation } from "@/lib/meta/roles";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { matchPerson } from "../match";
import type { ImportContext, ImportPlan, Importer } from "../types";
import { notionPayload, type NotionBlock, type NotionDatabasePayload, type NotionPagePayload, type NotionPayload } from "./schema";

export const NOTION_GRAPH_KINDS = ["personal", "work", "project", "shared", "other"];
const MAX_PEOPLE = 500;

const PEOPLE_WORDS = /\b(people|persons?|contacts?|team|members|staff|employees|crm|customers|clients|directory|kontakter|personer|medarbejdere|kunder|klienter|holdet|ansatte)\b/i;
const ROLE_COLUMN = /^(role|title|job ?title|position|stilling|rolle|titel)$/i;
const ORG_COLUMN = /^(company|organi[sz]ation|employer|firma|virksomhed|arbejdsplads)$/i;

function parse(bytes: Buffer): { data: NotionPayload | null; problem: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return { data: null, problem: "The Notion batch isn't valid JSON." }; }
  const r = notionPayload.safeParse(raw);
  return r.success ? { data: r.data, problem: null } : { data: null, problem: `The Notion batch doesn't have the expected shape (${r.error.issues[0]?.path.join(".") || "root"}).` };
}

/** One block as a line of text, keeping headings and list structure readable. */
export function blockLine(b: NotionBlock): string {
  const pad = "  ".repeat(b.depth);
  switch (b.type) {
    case "heading": return `${"#".repeat(b.level ?? 1)} ${b.text}`;
    case "list": return `${pad}• ${b.text}`;
    case "todo": return `${pad}[${b.checked ? "x" : " "}] ${b.text}`;
    case "quote": return `${pad}> ${b.text}`;
    case "child": return `${pad}↳ ${b.text}`;
    case "divider": return "---";
    default: return `${pad}${b.text}`;
  }
}

/** Does this database look like a list of people? */
export function looksLikePeople(db: Pick<NotionDatabasePayload, "database" | "properties">): boolean {
  const hasContact = db.properties.some((p) => p.type === "email" || p.type === "phone_number");
  return hasContact || PEOPLE_WORDS.test(db.database.title);
}

function readPage(d: NotionPagePayload, ctx: ImportContext): ImportPlan {
  const segments: TextSegment[] = [{ text: `# ${d.page.title}`, at: { region: `page:${d.page.id}` } }];
  if (d.values.length) segments.push({ text: d.values.map((v) => `${v.name}: ${v.value}`).join("\n"), at: { region: "properties" } });
  // Consecutive short blocks under one heading stay in one passage; a heading starts a new one.
  let buf: string[] = [];
  let first: string | null = null;
  const flush = () => { if (buf.length) segments.push({ text: buf.join("\n"), at: { region: `block:${first}` } }); buf = []; first = null; };
  for (const b of d.blocks) {
    if (b.type === "heading") flush();
    const line = blockLine(b);
    if (!line.trim()) continue;
    if (!first) first = b.id;
    buf.push(line);
    if (buf.join("\n").length > 1500) flush();
  }
  flush();

  const changes: ChangeInput[] = [];
  let added = 0, matched = 0;
  const text = segments.map((s) => s.text).join("\n");
  for (const p of d.mentions.people) {
    if (roleMention(p.name)) continue;
    const hit = matchPerson(ctx.known, { name: p.name, emails: p.email ? [p.email] : [] });
    if (hit) { matched++; continue; }
    if (added >= MAX_PEOPLE) break;
    const at = text.indexOf(`@${p.name}`);
    const quote = at >= 0 ? text.slice(Math.max(0, text.lastIndexOf("\n", at) + 1), Math.min(text.length, at + p.name.length + 200)).split("\n")[0] : `@${p.name}`;
    changes.push({
      op: "addNode", nodeId: ctx.mint(), type: "person", label: p.name,
      props: { ...(p.email ? { email: p.email } : {}), notionUserId: p.id },
      visibility: ctx.visibility, note: "Mentioned on a Notion page.",
      receipt: { sourceId: ctx.sourceId, quote: quote.slice(0, 300), url: d.page.url },
    });
    added++;
  }
  const blocks = d.blocks.filter((b) => b.type !== "divider").length;
  return {
    segments, changes, extract: blocks > 0 || d.values.length > 0,
    counts: { blocks, people: added, matched, dates: d.mentions.dates.length },
    title: d.page.title,
    occurredAt: d.page.createdAt ? new Date(d.page.createdAt) : null,
  };
}

function readDatabase(d: NotionDatabasePayload, ctx: ImportContext): ImportPlan {
  const da = ctx.locale === "da";
  const segments: TextSegment[] = [{ text: `${d.database.title} (${d.rows.length} ${da ? "rækker" : "rows"})`, at: { region: `database:${d.database.id}` } }];
  for (const r of d.rows) {
    segments.push({ text: [r.title, ...r.values.map((v) => `${v.name}: ${v.value}`)].join("; "), at: { region: `row:${r.id}` } });
  }
  const people = looksLikePeople(d);
  const changes: ChangeInput[] = [];
  let added = 0, matched = 0, left = 0;
  if (people) {
    for (const r of d.rows) {
      const name = r.title.trim();
      if (!name || name === "Untitled") continue;
      const hit = matchPerson(ctx.known, { name, emails: r.emails, phones: r.phones });
      if (hit) { matched++; continue; }
      if (added >= MAX_PEOPLE) { left++; continue; }
      if (roleMention(name)) continue;
      const role = r.values.find((v) => ROLE_COLUMN.test(v.name) && v.type !== "title")?.value;
      const org = r.values.find((v) => ORG_COLUMN.test(v.name))?.value;
      const personId = ctx.mint();
      changes.push({
        op: "addNode", nodeId: personId, type: "person", label: name.slice(0, 200),
        props: {
          ...(r.emails[0] ? { email: r.emails[0] } : {}), ...(r.emails.length > 1 ? { emails: r.emails } : {}),
          ...(r.phones[0] ? { phone: r.phones[0] } : {}), ...(role ? { jobTitle: role } : {}), ...(org ? { organization: org } : {}),
          notionPageId: r.id,
        },
        visibility: ctx.visibility,
        receipt: { sourceId: ctx.sourceId, quote: [r.title, ...r.values.map((v) => `${v.name}: ${v.value}`)].join("; ").slice(0, 300), url: r.url, locator: { region: `row:${r.id}` } },
      });
      // The role column, when it names a role, is a role they hold (no known context: the organisation is only a name here).
      const held = detectRole(role ?? null);
      if (held && !held.family) {
        changes.push({ op: "addEdge", fromId: personId, toId: personId, relation: roleRelation(held.role), confidence: 0.8, status: "unconfirmed",
          receipt: { sourceId: ctx.sourceId, quote: `${name}: ${role}`.slice(0, 300), url: r.url, locator: { region: `row:${r.id}` } } });
      }
      added++;
    }
  }
  return {
    segments, changes,
    warnings: left ? [`${left} more people weren't proposed this time; deliver or drop these first.`] : [],
    // A contact list is understood row by row; any other database is read by the model like a document.
    extract: !people && d.rows.length > 0,
    counts: { rows: d.rows.length, people: added, matched },
    title: d.database.title,
  };
}

export const notionApiImporter: Importer = {
  id: "notion",
  label: "Notion",
  mime: "application/json",
  // Only the Notion connector makes these sources (the workspace export .zip is `notion_export`).
  detect: () => false,
  graphKinds: NOTION_GRAPH_KINDS,
  read(input, ctx) {
    const { data, problem } = parse(input.bytes);
    if (!data) return { segments: [], changes: [], counts: {}, warnings: [problem!] };
    return data.kind === "page" ? readPage(data, ctx) : readDatabase(data, ctx);
  },
};
